import { getRequestConfig } from "next-intl/server";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export default getRequestConfig(async () => {
  const directory = join(process.cwd(), "messages", "th");
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  );
  const entries = await Promise.all(
    files.map(async (name) => [
      name.slice(0, -5),
      JSON.parse(await readFile(join(directory, name), "utf8")),
    ]),
  );
  return {
    locale: "th",
    messages: Object.fromEntries(entries),
    timeZone: "Asia/Bangkok",
  };
});
