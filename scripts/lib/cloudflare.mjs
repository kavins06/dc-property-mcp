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
