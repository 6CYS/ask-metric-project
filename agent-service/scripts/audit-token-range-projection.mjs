import {readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const [reportArgument, baselineRoot, candidateRoot] = process.argv.slice(2);
if (!reportArgument || !baselineRoot || !candidateRoot) throw new Error('report baseline-root candidate-root required');
const reportPath = resolve(reportArgument);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const sha = text => createHash('sha256').update(text).digest('hex');
const text = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('') : '';
async function findSession(root, id) {
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) {const found = await findSession(file, id); if (found) return found;}
    else if (entry.name.endsWith(`_${id}.jsonl`)) return file;
  }
}
const projectors = await Promise.all([baselineRoot, candidateRoot].map(root =>
  import(pathToFileURL(join(resolve(root), 'src/sessionProjection.ts')).href)));
const rows = [];
for (const task of report.tasks.filter(task => task.case_id === 'empty-result')) {
  let nativePath;
  for (const root of report.native_session_directories ?? [report.native_session_directory]) {
    nativePath = await findSession(root, task.session_id); if (nativePath) break;
  }
  if (!nativePath) throw new Error(`native session missing: ${task.session_id}`);
  const bytes = await readFile(nativePath, 'utf8');
  const records = bytes.trim().split('\n').flatMap(line => {const row = JSON.parse(line); return Array.isArray(row) ? row : [row];});
  const entries = [...new Map(records.filter(row => row.kind === 'entry').map(row => [row.id, row])).values()].sort((a, b) => a.seq - b.seq);
  const lastUser = entries.findLastIndex(entry => entry.type === 'message' && entry.message.role === 'user');
  const current = entries.slice(lastUser);
  const sources = new Map(current.map(entry => [entry.id, entry]));
  rows.push({version: task.version, session_id: task.session_id, native_path: nativePath, native_sha256: sha(bytes),
    native_assistants: current.filter(entry => entry.message?.role === 'assistant').map(entry => ({entry_id: entry.id, seq: entry.seq,
      stop_reason: entry.message.stopReason ?? null, raw_stop_reason: entry.message.rawStopReason ?? null,
      error: entry.message.errorMessage ?? null, text_length: text(entry.message.content).length,
      text_sha256: sha(text(entry.message.content)), tool_names: (Array.isArray(entry.message.content) ? entry.message.content : []).filter(b => b.type === 'toolCall').map(b => b.name)})),
    projections: projectors.map((module, index) => {
      const answers = module.projectEntries(current).filter(message => message.role === 'assistant' && message.text.trim());
      return {source: index === 0 ? 'baseline' : 'candidate', assistant_count: answers.length, answers: answers.map(answer => {
        const source = sources.get(answer.entry_id) ?? sources.get(answer.entry_id.replace(/:answer$/, ''));
        return {entry_id: answer.entry_id, native_entry_id: source?.id ?? null, native_seq: source?.seq ?? null,
          native_role: source?.message?.role ?? null, native_tool_name: source?.message?.toolName ?? null,
          native_stop_reason: source?.message?.stopReason ?? null, projected_error: answer.error ?? null,
          text_length: answer.text.length, text_sha256: sha(answer.text)};
      })};
    })});
}
const result = {report: reportPath, report_sha256: sha(await readFile(reportPath)),
  method: 'The same immutable native entries are replayed through both frozen projection modules. No model, backend or database calls.',
  projection_sources: await Promise.all([baselineRoot, candidateRoot].map(async root => ({root: resolve(root),
    module_sha256: sha(await readFile(join(root, 'src/sessionProjection.ts')))}))), sessions: rows};
const output = reportPath.replace(/\.json$/, '-range-projection.json');
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({output, sessions: rows.map(row => ({version: row.version, counts: row.projections.map(p => [p.source, p.assistant_count])}))}));
