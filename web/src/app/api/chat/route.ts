import { createVertex } from "@ai-sdk/google-vertex";
import { getVercelOidcToken } from "@vercel/oidc";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { ExternalAccountClient } from "google-auth-library";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type ToolSet,
  type UIMessage,
} from "ai";
import { requestUserInputTool } from "@/ai/request-input";
import { PROPERTY_AGENT_INSTRUCTIONS } from "@/server/agent";
import { getServerEnv } from "@/server/env";
import { createPropertyMcpClient } from "@/server/mcp";

export const maxDuration = 60;

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_MESSAGES = 60;
type RuntimeMessage = UIMessage<
  unknown,
  never,
  Record<string, { input: any; output: any }>
>;

export async function POST(request: Request) {
  const { accessToken } = await withAuth({ ensureSignedIn: true });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "Conversation is too large." }, { status: 413 });
  }

  let messages: UIMessage[];
  try {
    const body = JSON.parse(raw) as { messages?: UIMessage[] };
    if (!Array.isArray(body.messages) || body.messages.length > MAX_MESSAGES) {
      return Response.json({ error: "Invalid conversation." }, { status: 400 });
    }
    messages = body.messages;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const env = getServerEnv();
  const authClient = env.GCP_PROJECT_NUMBER
    ? ExternalAccountClient.fromJSON({
        type: "external_account",
        audience: `//iam.googleapis.com/projects/${env.GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${env.GCP_WORKLOAD_IDENTITY_POOL_ID}/providers/${env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID}`,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: "https://sts.googleapis.com/v1/token",
        service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.GCP_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
        subject_token_supplier: { getSubjectToken: getVercelOidcToken },
      })
    : null;
  const vertex = createVertex({
    project: env.GOOGLE_VERTEX_PROJECT,
    location: env.GOOGLE_VERTEX_LOCATION,
    ...(authClient && {
      googleAuthOptions: { authClient, projectId: env.GOOGLE_VERTEX_PROJECT },
    }),
  });
  const { client, tools: propertyTools } = await createPropertyMcpClient(accessToken);
  const tools = {
    ...propertyTools,
    request_user_input: requestUserInputTool,
  } as ToolSet;

  try {
    const validated = await validateUIMessages<RuntimeMessage>({ messages, tools });
    const result = streamText({
      model: vertex(env.GEMINI_MODEL),
      instructions: PROPERTY_AGENT_INSTRUCTIONS,
      messages: await convertToModelMessages(validated),
      tools,
      temperature: 0.2,
      maxOutputTokens: 4_000,
      stopWhen: stepCountIs(8),
      abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]),
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        originalMessages: validated,
        onEnd: async () => client.close(),
        onError: () => "Quoin could not complete that request.",
      }),
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    await client.close();
    if (error instanceof Error && error.name === "TypeValidationError") {
      return Response.json({ error: "Conversation data is invalid." }, { status: 400 });
    }
    throw error;
  }
}
