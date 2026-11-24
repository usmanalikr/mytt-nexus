// Assertions for the Deno suites, with no dependency to download.
//
// The obvious choice is jsr:@std/assert, but jsr.io is outside the cloud
// environment's network allowlist, so a suite that imports it cannot run here
// at all. `node:assert` is built into Deno and needs no network, which makes
// the tests runnable in any environment rather than only in one with the right
// domains allowed.
//
// Slice T owns this file along with the *.test.ts files that use it.

import { deepStrictEqual, notDeepStrictEqual, rejects } from "node:assert/strict";

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  deepStrictEqual(actual, expected, message);
}

export function assertNotEquals<T>(actual: T, expected: T, message?: string): void {
  notDeepStrictEqual(actual, expected, message);
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  message?: string,
): Promise<void> {
  // A predicate rather than an object: node:assert's second argument is an
  // AssertPredicate, and a bare { message } is not one of its overloads.
  await rejects(fn, (error: unknown) => {
    if (!message) return true;
    return String((error as Error)?.message ?? error).includes(message);
  });
}
