import { expect, test } from "bun:test";
import * as os from "node:os";
import { CAP, classify, exec, peakKb, type Proc } from "../src/run";
import { available, groupSums, parseStat } from "../src/watch";

const proc = (code: number | null, extra: Partial<Proc> = {}): Proc =>
  ({ code, signal: null, out: "", err: "", ms: 1, timedOut: false, ...extra });

test("a check the watchdog killed is fail-oom, not a crash or a timeout", () => {
  expect(classify(proc(null, { signal: "SIGKILL", oom: "cap", peakKb: 5e6 }), "")).toBe("fail-oom");
  expect(classify(proc(null, { signal: "SIGKILL", oom: "total", timedOut: true }), "")).toBe("fail-oom");
  expect(peakKb(proc(1, { rssKb: 100, peakKb: 300 }))).toBe(300);
  expect(peakKb(proc(1, { rssKb: 400, peakKb: 300 }))).toBe(400);
  expect(peakKb(proc(1))).toBe(undefined);
});

test("parseStat reads a command name with spaces and parentheses", () => {
  const st = parseStat("4242 (bun (worker) x) S 10 4200 4100 0 -1 4194304 1 0 0 0 5 6 0 0 20 0 3 0 100 123456 789 18446744073709551615");
  expect(st).toEqual({ pid: 4242, ppid: 10, pgrp: 4200, sid: 4100, rssPages: 789 });
  expect(parseStat("garbage")).toBe(null);
});

test("groupSums counts the group, its session, and descendants that left both", () => {
  const p = (pid: number, ppid: number, pgrp: number, sid: number, rssPages: number) => ({ pid, ppid, pgrp, sid, rssPages });
  const procs = [
    p(100, 1, 100, 100, 10),     // the group leader (spawned detached)
    p(101, 100, 100, 100, 20),   // its child
    p(102, 101, 102, 102, 30),   // a grandchild that called setsid
    p(103, 102, 103, 102, 40),   // and its child in a new group
    p(200, 1, 200, 200, 1000),   // someone else
    p(201, 200, 200, 200, 1000),
  ];
  expect(groupSums(procs, [100])).toEqual(new Map([[100, 100]]));
  expect(groupSums(procs, [100, 200])).toEqual(new Map([[100, 100], [200, 2000]]));
});

test.skipIf(!available())("exec kills a process group that passes its memory cap", async () => {
  // a child of the spawned shell allocates about 50 MB per step, forever
  const hog = `${process.execPath} -e 'const a = []; for (;;) { a.push(Buffer.alloc(50e6, 1)); Bun.sleepSync(20); }'`;
  const p = await exec(["sh", "-c", hog + "; echo unreachable"], { cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 30_000, nice: false, memCapKb: 300 * 1024 });
  expect(p.oom).toBe("cap");
  expect(p.timedOut).toBe(false);
  expect(p.peakKb ?? 0).toBeGreaterThan(300 * 1024);
  expect(p.ms).toBeLessThan(15_000);
  expect(classify(p, p.err)).toBe("fail-oom");
}, 40_000);

test("exec leaves a process under its cap alone and cuts output at exactly CAP bytes", async () => {
  const p = await exec([process.execPath, "-e", `process.stdout.write("x".repeat(${CAP * 3}))`], { cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 30_000, nice: false, memCapKb: 2 * 1024 * 1024 });
  expect(p.code).toBe(0);
  expect(p.oom).toBe(undefined);
  expect(p.out.length).toBe(CAP);
  expect(p.truncated).toBe(true);
});

test("exec kills the whole group at the timeout", async () => {
  const p = await exec(["sh", "-c", "sleep 30 & sleep 30; wait"], { cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 300, nice: false });
  expect(p.timedOut).toBe(true);
  expect(classify(p, "")).toBe("timeout");
});
