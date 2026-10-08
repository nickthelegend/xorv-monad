import { expect, it } from "vitest";
import { identityLabel } from "@/lib/identity-label";
const valid = { gate: { address: "0x123", kind: "cleanverse" as const }, verified: true, checkedAt: 1000 };
it("never claims verification from missing gate, failed, unknown or stale reads", () => {
  expect(identityLabel(null, false, 1000).verified).toBe(false);
  expect(identityLabel({gate:null,verified:true,checkedAt:1000}, false, 1000).verified).toBe(false);
  expect(identityLabel(valid, true, 1000).verified).toBe(false);
  expect(identityLabel(valid, false, 61001).verified).toBe(false);
  expect(identityLabel({...valid, checkedAt:null}, false, 1000).verified).toBe(false);
  expect(identityLabel({...valid, verified:null}, false, 1000).verified).toBe(false);
});
it("labels a fresh positive and a fresh negative gate read distinctly", () => {
  expect(identityLabel(valid, false, 1001)).toEqual({label:"Cleanverse verified",verified:true});
  expect(identityLabel({...valid,verified:false}, false, 1001)).toEqual({label:"No active Cleanverse A-Pass",verified:false});
});
