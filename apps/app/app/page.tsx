import Link from "next/link";
import { Composer } from "@/components/composer";
import { JobList, ProviderList } from "@/components/live-lists";

export default function Home() {
  return (
    <div className="space-y-14">
      <section className="pt-4">
        <Composer />
      </section>

      <div className="grid gap-10 lg:grid-cols-[1.25fr_1fr] lg:gap-12">
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-[13px] font-medium text-fg">Recent jobs</h2>
            <Link href="/jobs" className="text-[12px] text-fg-3 transition-colors hover:text-fg">
              Browse all jobs →
            </Link>
          </div>
          <JobList />
        </section>
        <section>
          <h2 className="mb-3 text-[13px] font-medium text-fg">Live providers</h2>
          <ProviderList />
        </section>
      </div>
    </div>
  );
}
