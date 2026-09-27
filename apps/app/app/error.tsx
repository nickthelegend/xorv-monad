"use client";

import { useEffect } from "react";
import { Button, Panel } from "@/components/ui";

/**
 * A page that threw while rendering.
 *
 * Without this, one bad render — a wallet SDK choking on a payload, a result
 * the page can't parse — unmounts the whole app and Next shows its bare
 * "Application error". Here the shell stays up, the visitor is told nothing
 * was lost, and "Try again" re-renders the page. A payment is either settled
 * on-chain or never signed; a render error cannot leave one half-done.
 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Panel className="mx-auto max-w-xl p-6 text-center">
      <p className="text-[14px] font-medium text-fg">This page hit an error</p>
      <p className="measure mx-auto mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        Something on it failed to render. Nothing was paid or signed because of this; any payment you
        already approved is settled on Monad and shows on the job&rsquo;s page.
      </p>
      {error.message ? <p className="mono mt-3 break-words text-[11.5px] text-fg-4">{error.message}</p> : null}
      <div className="mt-4 flex justify-center gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="secondary" href="/">
          All jobs
        </Button>
      </div>
    </Panel>
  );
}
