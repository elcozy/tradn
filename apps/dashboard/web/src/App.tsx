import { useEffect, useState } from "react";
import { get, useLive, type Config } from "./api";
import { BacktestsPage } from "./pages/BacktestsPage";
import { ChartPage } from "./pages/ChartPage";
import { ControlsPage } from "./pages/ControlsPage";
import { JournalPage } from "./pages/JournalPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ScorecardPage } from "./pages/ScorecardPage";

const PAGES = ["Chart", "Overview", "Journal", "Scorecard", "Backtests", "Controls"] as const;
type Page = (typeof PAGES)[number];

export function App() {
  const [page, setPage] = useState<Page>(() => (location.hash.slice(1) as Page) || "Chart");
  const [config, setConfig] = useState<Config | null>(null);
  const [tick, setTick] = useState(0); // bumps on every engine event so pages refetch
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);
  const connected = useLive((m) => {
    if (m.kind === "event") setTick((t) => t + 1);
  });

  useEffect(() => {
    get<Config>("/api/config").then(setConfig).catch(console.error);
  }, []);
  useEffect(() => {
    location.hash = page;
  }, [page]);

  const showOnChart = (id: string) => {
    setSelectedSignal(id);
    setPage("Chart");
  };

  if (!config) return <main>loading…</main>;
  return (
    <>
      <nav>
        {PAGES.map((p) => (
          <button key={p} className={p === page ? "active" : ""} onClick={() => setPage(p)}>
            {p}
          </button>
        ))}
        <div className="spacer" />
        <span className="pill">{config.mode}</span>
        <span className={`pill ${connected ? "on" : "off"}`}>{connected ? "live" : "offline"}</span>
      </nav>
      <main>
        {page === "Chart" && <ChartPage config={config} tick={tick} selectedSignal={selectedSignal} onSelectSignal={setSelectedSignal} />}
        {page === "Overview" && <OverviewPage tick={tick} onShowOnChart={showOnChart} />}
        {page === "Journal" && <JournalPage config={config} tick={tick} onShowOnChart={showOnChart} />}
        {page === "Scorecard" && <ScorecardPage tick={tick} />}
        {page === "Backtests" && <BacktestsPage tick={tick} />}
        {page === "Controls" && <ControlsPage tick={tick} />}
      </main>
    </>
  );
}
