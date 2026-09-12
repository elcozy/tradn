/** key → value chips instead of a raw JSON blob (params, exit settings, signal meta, close reasons). */
export function KV({ title, data }: { title?: string; data: Record<string, unknown> | undefined | null }) {
  const entries = Object.entries(data ?? {});
  if (entries.length === 0) return null;
  const show = (v: unknown) =>
    v === null ? "off" : typeof v === "number" ? (Number.isInteger(v) ? v : Number(v.toPrecision(6))) : typeof v === "object" ? JSON.stringify(v) : String(v);
  return (
    <div className="kv">
      {title && <span className="kv-title">{title}</span>}
      {entries.map(([k, v]) => (
        <span key={k} className="kv-item"><span className="flat">{k}</span> {show(v)}</span>
      ))}
    </div>
  );
}
