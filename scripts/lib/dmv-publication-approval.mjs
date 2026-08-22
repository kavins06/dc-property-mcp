const APPROVAL_MARKER = "DMV_OWNER_APPROVED_PUBLICATION";

export function assertDmvPublicationApproval(environment = process.env, { bundleSha256 } = {}) {
  if (environment.DMV_OWNER_PUBLICATION_APPROVAL !== APPROVAL_MARKER) {
    throw new Error("DMV production load, deployment, promotion, and publication require explicit owner approval.");
  }
  if (
    bundleSha256
    && environment.DMV_OWNER_APPROVED_BUNDLE_SHA256 !== bundleSha256
  ) {
    throw new Error("DMV owner approval is not bound to this exact Worker bundle SHA-256.");
  }
}
