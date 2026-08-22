export function createCloudflareClient({
  accountId,
  token,
  scriptName,
}) {
  if (!accountId || !token || !scriptName) {
    throw new Error("Cloudflare credentials or Worker name are missing.");
  }

  const accountBase =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const scriptBase = `${accountBase}/workers/scripts/${scriptName}`;

  async function call(base, path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      throw new Error(
        `Cloudflare API request failed (${response.status} ${path}): ` +
          JSON.stringify(payload.errors ?? []),
      );
    }
    return payload.result;
  }

  const request = (path, options) =>
    call(scriptBase, path, options);
  const accountRequest = (path, options) =>
    call(accountBase, path, options);
  const createDeployment = (versions, message) =>
    request("/deployments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        strategy: "percentage",
        versions,
        annotations: { "workers/message": message },
      }),
    });

  return { request, accountRequest, createDeployment };
}

export function assertExactDeployment(deployment, expectedId, expectedVersions) {
  const actual = new Map(
    (deployment?.versions ?? []).map(({ version_id, percentage }) => [
      version_id,
      percentage,
    ]),
  );
  const expected = new Map(
    expectedVersions.map(({ version_id, percentage }) => [version_id, percentage]),
  );
  if (
    deployment?.id !== expectedId ||
    deployment?.strategy !== "percentage" ||
    actual.size !== expectedVersions.length ||
    actual.size !== expected.size ||
    [...expected].some(([id, percentage]) => actual.get(id) !== percentage)
  ) {
    throw new Error("The active Cloudflare deployment is not the exact reviewed deployment.");
  }
}

export function assertVersionBindings(version, expectedBindings) {
  const bindings = version?.resources?.bindings ?? version?.bindings ?? [];
  for (const expected of expectedBindings) {
    const actual = bindings.find(
      (binding) => binding.type === expected.type && binding.name === expected.name,
    );
    if (actual?.id !== expected.id) {
      throw new Error("Worker version does not use the reviewed binding set.");
    }
  }
}
