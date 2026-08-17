import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureToolSuccesses,
  productAnalyticsId,
  successfulToolFamilies,
  toolCalls,
  toolFamily,
} from '../src/analytics';
import type { Env } from '../src/types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('privacy-safe activation analytics', () => {
  it('uses the same stable namespace hash without exposing the WorkOS subject', async () => {
    const subject = 'user_01SECRET';
    const first = await productAnalyticsId(subject);
    const second = await productAnalyticsId(subject);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(subject);
  });

  it('classifies tool families without retaining arguments', async () => {
    expect(toolFamily('get_assessment_history')).toBe('assessments');
    expect(toolFamily('get_latest_sale_and_deed')).toBe('deeds_and_sales');
    const request = new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'get_tax_history', arguments: { address: '1717 K Street NW' } },
      }),
    });
    await expect(toolCalls(request)).resolves.toEqual([{ id: '7', family: 'taxes' }]);
  });

  it('records only successful tool results and excludes requests and responses', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => (
      new Response(null, { status: 202 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const response = Response.json({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'Owner at 1717 K Street NW' }] },
    });
    const calls = [{ id: '7', family: 'taxes' }];
    await expect(successfulToolFamilies(response, calls)).resolves.toEqual(['taxes']);
    await captureToolSuccesses({
      WORKOS_AUTHKIT_DOMAIN: 'auth.example.com',
      WORKOS_RESOURCE_URI: 'https://mcp.example.com/mcp',
      ALLOWED_ORIGINS: '',
      POSTHOG_PROJECT_KEY: 'phc_test',
    } as Env, 'user_01SECRET', calls, response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(payload).toContain('mcp_tool_call_succeeded');
    expect(payload).toContain('"tool_family":"taxes"');
    expect(payload).not.toContain('1717 K Street');
    expect(payload).not.toContain('Owner at');
    expect(payload).not.toContain('user_01SECRET');
  });

  it('does not record JSON-RPC or MCP result errors', async () => {
    const calls = [{ id: '1', family: 'permits' }, { id: '2', family: 'licenses' }];
    const response = Response.json([
      { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'failed' } },
      { jsonrpc: '2.0', id: 2, result: { isError: true, content: [] } },
    ]);
    await expect(successfulToolFamilies(response, calls)).resolves.toEqual([]);
  });
});
