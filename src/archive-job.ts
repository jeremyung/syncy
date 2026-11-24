import { isTracked } from "./archive-catalog.ts";
import { compareCopies } from "./archive-pair.ts";
import type { Config } from "./config.ts";
import { ENGINE_PROTOCOL_VERSION, type JobEvent } from "./engine-protocol.ts";
import { type JobOwnerRecord, withJobOwnership } from "./job-owner.ts";
import { checkBuild, DEFAULT_RSYNC } from "./rsync.ts";
import { appendHistory, type HistoryEntry, type Method } from "./state.ts";

export function runPairJob(
  config: Config,
  unit: string,
  endpoints: string[],
  method: Method,
  opts: {
    actor: JobOwnerRecord["actor"];
    signals?: boolean;
    signal?: AbortSignal;
    onEvent: (e: JobEvent) => void;
  },
) {
  const base = {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    jobId: crypto.randomUUID(),
    unit,
    target: [...endpoints].sort().join(" ↔ "),
    operation: method,
  };
  return withJobOwnership(
    opts.actor,
    method,
    async (job) => {
      const send = (event: JobEvent) => {
        job.lease.observe(event);
        opts.onEvent(event);
      };
      const signal = opts.signal ? AbortSignal.any([job.signal, opts.signal]) : job.signal;
      let terminalRecorded = false;
      const finish = (outcome: "completed" | "failed" | "cancelled", detail: string) => {
        if (terminalRecorded) return;
        const entry: HistoryEntry = {
          ts: Date.now(),
          unit,
          target: base.target,
          operation: method,
          outcome,
          detail,
          argv: [],
          exitCode: null,
          comparisonEndpoints: [...endpoints].sort(),
        };
        appendHistory(entry);
        terminalRecorded = true;
      };
      try {
        if (!isTracked(config, unit))
          throw new Error("Resume tracking this folder before comparing copies");
        const build = await checkBuild(DEFAULT_RSYNC);
        if (!build.ok) throw new Error(build.detail);
        const result = await compareCopies(config, unit, endpoints, method, {
          signal,
          phase: (phase) => send({ ...base, type: "job.phase-changed", at: Date.now(), phase }),
        });
        finish("completed", result.detail);
        send({ ...base, type: "pair.completed", at: result.at, result });
        return result;
      } catch (error) {
        finish(signal.aborted ? "cancelled" : "failed", String(error));
        send(
          signal.aborted
            ? { ...base, type: "job.cancelled", at: Date.now() }
            : {
                ...base,
                type: "job.failed",
                at: Date.now(),
                message: String(error),
                exitCode: null,
              },
        );
        throw error;
      }
    },
    {
      signals: opts.signals ?? false,
      onRefused: (refusal) => {
        throw new Error(refusal.message);
      },
    },
  );
}
