export const organizationBranding: Record<string, {
  shortName: string
  badgeText: string
  optionalDescription?: string
}> = {
  JYRCB: { shortName: "江阴农商行", badgeText: "江阴" },
  HCRCB: { shortName: "海城农商行", badgeText: "海城" },
}

export function resolveOrganizationBranding(orgCode: string, orgName: string) {
  return organizationBranding[orgCode] ?? {
    shortName: orgName,
    badgeText: orgName.replace(/农村商业银行|农商银行|农商行|银行/g, "").slice(0, 4) || orgCode.slice(0, 4),
  }
}
