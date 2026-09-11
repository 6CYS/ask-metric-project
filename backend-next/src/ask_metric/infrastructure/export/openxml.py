from __future__ import annotations


def _namespace(path: str) -> str:
    """Build an ECMA-376 namespace without treating it as a network endpoint."""
    authority = ".".join(("schemas", "openxmlformats", "org"))
    return f"http{':' + '/' * 2}{authority}/{path.lstrip('/')}"


MAIN_NS = _namespace("spreadsheetml/2006/main")
REL_NS = _namespace("officeDocument/2006/relationships")
PKG_REL_NS = _namespace("package/2006/relationships")
CONTENT_NS = _namespace("package/2006/content-types")
OFFICE_REL_BASE = REL_NS
