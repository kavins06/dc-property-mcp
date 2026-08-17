import type { Env } from './types';

const ANALYTICS_NAMESPACE = 'quoin-workos-v1:';

type ToolCall = {
  id: string;
  family: string;
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function productAnalyticsId(workosUserId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${ANALYTICS_NAMESPACE}${workosUserId}`),
  );
  return hex(new Uint8Array(digest));
}

export function toolFamily(name: string): string {
  if (name.includes('assessment')) return 'assessments';
  if (name.includes('tax')) return 'taxes';
  if (name.includes('sale') || name.includes('deed')) return 'deeds_and_sales';
  if (name.includes('permit')) return 'permits';
  if (name.includes('license')) return 'licenses';
  if (name.includes('inspection') || name.includes('enforcement')) return 'inspections';
  if (name.includes('building') || name.includes('land')) return 'building_and_land';
  if (name.includes('energy') || name.includes('benchmark')) return 'energy';
  if (name.includes('resolve') || name.includes('search')) return 'property_resolution';
  if (name.includes('describe')) return 'service_metadata';
  return 'property_record';
}

export async function toolCalls(request: Request): Promise<ToolCall[]> {
  if (request.method !== 'POST') return [];
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return [];
  try {
    const body = await request.clone().json<unknown>();
    const messages = Array.isArray(body) ? body : [body];
    return messages.flatMap((message) => {
      if (!message || typeof message !== 'object') return [];
      const value = message as {
        id?: string | number | null;
        method?: string;
        params?: { name?: string };
      };
      if (value.method !== 'tools/call' || typeof value.params?.name !== 'string') return [];
      if (value.id === undefined || value.id === null) return [];
      return [{ id: String(value.id), family: toolFamily(value.params.name) }];
    });
  } catch {
    return [];
  }
}

export async function successfulToolFamilies(
  response: Response,
  calls: ToolCall[],
): Promise<string[]> {
  if (!response.ok || calls.length === 0) return [];
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return [];
  try {
    const body = await response.clone().json<unknown>();
    const messages = Array.isArray(body) ? body : [body];
    const successfulIds = new Set(messages.flatMap((message) => {
      if (!message || typeof message !== 'object') return [];
      const value = message as {
        id?: string | number | null;
        error?: unknown;
        result?: { isError?: boolean };
      };
      if (value.id === undefined || value.id === null || value.error || !value.result) return [];
      if (value.result.isError === true) return [];
      return [String(value.id)];
    }));
    return calls.filter((call) => successfulIds.has(call.id)).map((call) => call.family);
  } catch {
    return [];
  }
}

export async function captureToolSuccesses(
  env: Env,
  workosUserId: string,
  calls: ToolCall[],
  response: Response,
): Promise<void> {
  if (!env.POSTHOG_PROJECT_KEY) return;
  const families = await successfulToolFamilies(response, calls);
  if (families.length === 0) return;
  const distinctId = await productAnalyticsId(workosUserId);
  const host = env.POSTHOG_HOST || 'https://us.i.posthog.com';
  const environment = env.ENVIRONMENT || (
    env.WORKOS_RESOURCE_URI === 'https://mcp.quoindata.com/mcp' ? 'production' : 'preview'
  );
  await Promise.all(families.map(async (family) => {
    try {
      await fetch(`${host}/i/v0/e/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: env.POSTHOG_PROJECT_KEY,
          event: 'mcp_tool_call_succeeded',
          properties: {
            distinct_id: distinctId,
            $process_person_profile: false,
            environment,
            tool_family: family,
          },
          timestamp: new Date().toISOString(),
        }),
      });
    } catch {
      // Analytics must never affect MCP responses.
    }
  }));
}
