import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

import { PORTAL_ORIGIN } from "./contract.mjs";
import { profileDirectory, sleep } from "./runtime.mjs";

const profile = profileDirectory();
await mkdir(profile, { recursive: true });

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  acceptDownloads: false,
});
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(PORTAL_ORIGIN, { waitUntil: "domcontentloaded" });
  process.stdout.write(
    "Sign in to the D.C. Recorder portal in the opened window. " +
      "Credentials are entered only into the portal and are not read by this program.\n",
  );
  const deadline = Date.now() + 15 * 60 * 1000;
  let authenticated = false;
  while (!authenticated && Date.now() < deadline) {
    for (const candidate of context.pages()) {
      authenticated =
        (await candidate
          .getByRole("link", { name: "Sign Out" })
          .count()
          .catch(() => 0)) > 0;
      if (authenticated) break;
    }
    if (!authenticated) await sleep(1000);
  }
  if (!authenticated) {
    throw new Error("Recorder sign-in was not completed within 15 minutes.");
  }
  process.stdout.write(
    `Recorder session is ready in the dedicated automation profile: ${profile}\n`,
  );
} finally {
  await context.close();
}
