import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { XORV_ESCROW_ABI } from "@xorv/protocol/web";
import { decodeLogs, viewerPath } from "@/lib/chain-viewer";

const X = "https://testnet.monadvision.com";
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3" as const;
const ESCROW = "0x9a6f27d9bfDd9AbD20600D8e7EA3FfF6cEEaB377";

describe("in-app chain viewer", () => {
  it("maps explorer links to the viewer's pages, and leaves pages it doesn't have alone", () => {
    expect(viewerPath(X, `${X}/tx/0xabc`)).toBe("/chain/tx/0xabc");
    expect(viewerPath(X, `${X}/address/0xdef`)).toBe("/chain/address/0xdef");
    expect(viewerPath(X, `${X}/token/0xdef`)).toBe("/chain/address/0xdef");
    expect(viewerPath(X, `${X}/block/69000000`)).toBe("/chain/block/69000000");
    expect(viewerPath(X, `${X}/nft/0x8004/1`)).toBeNull();
    expect(viewerPath(X, "https://faucet.circle.com")).toBeNull();
  });

  it("decodes a USDC transfer and an XorvEscrow event, names the emitters, and keeps unknown logs raw", () => {
    const transfer = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
    const from = "0x1111111111111111111111111111111111111111";
    const to = ESCROW;
    const logs = [
      {
        address: USDC,
        logIndex: 0,
        topics: encodeEventTopics({ abi: transfer, eventName: "Transfer", args: { from, to } }) as [Hex, ...Hex[]],
        data: encodeAbiParameters([{ type: "uint256" }], [1000n]),
      },
      {
        address: "0x2222222222222222222222222222222222222222" as const,
        logIndex: 1,
        topics: ["0x" + "ab".repeat(32)] as [Hex],
        data: "0x" as Hex,
      },
    ];
    const funded = XORV_ESCROW_ABI.find((e) => e.type === "event" && e.name === "JobRefunded");
    expect(funded).toBeTruthy();
    const decoded = decodeLogs(logs, { [USDC.toLowerCase()]: "USDC", [ESCROW.toLowerCase()]: "XorvEscrow" });
    expect(decoded[0]).toMatchObject({ contract: "USDC", event: "Transfer", args: { from, to, value: "1000" } });
    expect(decoded[1]).toMatchObject({ contract: null, event: null });
    expect(decoded[1]!.raw?.topics[0]).toBe("0x" + "ab".repeat(32));
  });
});
