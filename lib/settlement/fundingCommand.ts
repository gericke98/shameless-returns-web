// The operator command that records a legacy exchange line's funding
// (scripts/fund-replacement-line.ts → lib/settlement/replacementFunding.ts).
// Its own module, with no imports, so the portal's refusal alert can name it
// without loading the operator path.

/** The scripts/fund-replacement-line.ts invocation for a refused replacement order. */
export function fundingCommand(orderId: string, productsorderId: number | string): string {
  return (
    `npx tsx --tsconfig tsconfig.scripts.json scripts/fund-replacement-line.ts --order ${orderId} ` +
    `--line ${productsorderId} --session <cs_… paid for the source order> --cents <funded cents> ` +
    `--evidence "<why this amount>" [--by <name>] --write`
  );
}
