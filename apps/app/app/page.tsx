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
          <h2 className="mb-3 text-[13px] font-medium text-fg">Recent jobs</h2>
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
