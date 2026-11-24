// The Swift release walkthrough resumes a folder in the native app, then asks
// this second client to check the same archive in the same fixture.
import { realpathSync } from "node:fs";
import { render } from "ink-testing-library";
import { loadConfig } from "../../src/config.ts";
import { configFile } from "../../src/paths.ts";
import { App } from "../../src/tui/App.tsx";
import { FIXTURE_ROOT, isInside, waitFor } from "../helpers.ts";

for (const variable of ["XDG_CONFIG_HOME", "XDG_STATE_HOME"]) {
  const path = process.env[variable];
  if (!path || !isInside(realpathSync(path), realpathSync(FIXTURE_ROOT)))
    throw new Error("The cross-client walkthrough needs isolated fixture directories");
}
const unit = process.argv[2];
if (!unit) throw new Error("A fixture folder is required");
const view = render(<App config={loadConfig(configFile())} />);
const see = (text: string) =>
  waitFor(() => view.lastFrame()?.includes(text) === true, { what: text });
try {
  const stage = process.argv[3] ?? "verify";
  await see(unit);
  if (stage === "returned") {
    await see("Local copy present");
    view.stdin.write("c");
    await see("Local copy present · awaiting check");
    await see("Only on Second disk · only-here");
  } else {
    await see("Absent locally");
    if (stage === "verify") {
      view.stdin.write("d");
      await see("[enter] deep check");
      await see("These copies have not been compared");
      view.stdin.write("\r");
      await see("Verified against each other");
    } else {
      view.stdin.write("\r");
      await see("Only on Second disk · only-here");
      if (stage === "offline") {
        await see("Historical");
        await see("not connected");
      }
    }
  }
} finally {
  view.unmount();
}
