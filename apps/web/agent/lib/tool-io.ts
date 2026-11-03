import { wrapToolResult } from "@neo/core";
import { z } from "zod";

/**
 * Optional input: null and blank strings count as absent. Models reached through a gateway with
 * strict tool calling fill every property (a string with "" or a number with 0), and a blank is
 * never a valid value here. Built from `nullish().transform()` so the input still has a JSON Schema.
 */
export function optionalInput<T extends z.ZodType>(schema: T) {
  return schema
    .or(z.literal(""))
    .nullish()
    .transform((v): z.output<T> | undefined => (v === null || v === undefined || v === "" ? undefined : (v as z.output<T>)));
}

/**
 * What the model sees of a tool's result: only the trust-boundary envelope. Everything a tool
 * returns is attacker-influenced (pages, messages, alert text quoting verdicts).
 */
export function wrappedModelOutput(toolName: string) {
  return (output: unknown): { type: "text"; value: string } => ({ type: "text", value: wrapToolResult(toolName, output) });
}
