import { Composer } from "@/components/composer";
import { JobList, ProviderList } from "@/components/live-lists";

export default function Home() {
  return (
    <div className="space-y-14">
      <section className="pt-4">
        <Composer />
      </section>

      {/* minmax(0, …) columns: a bare `fr` or implicit track is at least as wide
          as its content's min-content size, and a truncated (nowrap) job line
          made that 537px — the page overflowed a 375px phone. */}
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:gap-12">
        <section>
          <h2 className="mb-3 text-[13px] font-medium text-fg">Recent jobs</h2>
          <JobList />
        </section>
        <section>
          <h2 className="mb-3 text-[13px] font-medium text-fg">Live providers</h2>
          <ProviderList compact />
        </section>
      </div>
    </div>
  );
}
