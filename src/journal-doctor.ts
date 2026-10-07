import { diagnoseJournal } from "./doctor";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) {
  console.error("usage: bun run journal:doctor [config-dir]");
  process.exitCode = 2;
} else {
  const report = await diagnoseJournal(args[0]);
  console.log(JSON.stringify(report));
  process.exitCode = !report.complete ? 2 : report.counts.errors > 0 ? 1 : 0;
}
