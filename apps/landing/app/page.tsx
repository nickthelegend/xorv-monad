import { Navbar } from "@/components/navbar";
import { Hero } from "@/components/sections/hero";
import { How } from "@/components/sections/how";
import { Bento } from "@/components/sections/bento";
import { Earn } from "@/components/sections/earn";
import { Adapters } from "@/components/sections/adapters";
import { Ledger } from "@/components/sections/ledger";
import { Security } from "@/components/sections/security";
import { Faq } from "@/components/sections/faq";
import { Cta } from "@/components/sections/cta";
import { Footer } from "@/components/footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <How />
        <Bento />
        <Earn />
        <Adapters />
        <Ledger />
        <Security />
        <Faq />
        <Cta />
      </main>
      <Footer />
    </>
  );
}
