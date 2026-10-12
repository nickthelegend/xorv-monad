import { describe, expect, it } from "vitest";

describe("the escrow rule", () => {
  it("allows a USDC ReceiveWithAuthorization only into the given XorvEscrow, under the same cap", async () => {
    const { escrowRule, buildAgentPolicy } = await import("../src/privy-policy.js");
    const escrow = "0x87d57e81b71d3eF5172156b5f3c6D01f5b74Df91";
    const rule = escrowRule("eip155:10143", 50_000n, escrow);
    const byField = Object.fromEntries(rule.conditions.map((c) => [c.field, c]));
    expect(byField.value).toMatchObject({ operator: "lte", value: "50000" });
    expect((byField.to as { value: string[] }).value).toContain(escrow.toLowerCase());
    expect((byField.value as { typed_data: { primary_type: string } }).typed_data.primary_type).toBe("ReceiveWithAuthorization");
    // Without an escrow, the policy has no such rule.
    const plain = buildAgentPolicy({ network: "eip155:10143", capUnits: 50_000n });
    expect(plain.rules.some((r) => r.name.includes("escrow"))).toBe(false);
    expect(buildAgentPolicy({ network: "eip155:10143", capUnits: 50_000n, escrow }).rules.some((r) => r.name.includes("escrow"))).toBe(true);
  });
});
