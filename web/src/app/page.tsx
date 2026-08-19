import { withAuth } from "@workos-inc/authkit-nextjs";
import { ChatShell } from "@/components/chat/chat-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { user } = await withAuth({ ensureSignedIn: true });
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return <ChatShell userLabel={name || user.email} />;
}
