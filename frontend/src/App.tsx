import { useEffect, useState, useMemo } from "react";
import { format, parse } from "date-fns";
import {
  Sidebar,
  SidebarBody,
  SidebarLink,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  PhoneCall,
  CalendarCheck,
  Settings,
  PhoneIncoming,
  ChevronDown,
  Radio,
  CalendarDays,
  Table as TableIcon,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/api";
import { LiveCallPage } from "@/components/ui/live-call-page";
import { FullScreenCalendar, CalendarData, Event as CalendarEvent } from "@/components/ui/fullscreen-calendar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface CallRecord {
  id: number;
  room_name: string;
  caller_phone: string | null;
  outcome: string;
  transcript_summary: string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface Appointment {
  id: number;
  service: string;
  scheduled_for: string;
  status: string;
  notes: string | null;
  customer_name: string | null;
  customer_phone: string;
}

interface PublicConfig {
  company_name?: string;
  phone?: string;
  address?: string;
  timezone?: string;
  emergency_phone?: string;
  opening_hours?: Record<string, string>;
  services?: string[];
}

type Page = "dashboard" | "live-call" | "calls" | "appointments" | "settings";

interface ApiState<T> {
  data: T[];
  loaded: boolean;
  error: boolean;
  updatedAt: Date | null;
}

function useApi<T>(path: string, refreshMs = 10000): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({
    data: [],
    loaded: false,
    error: false,
    updatedAt: null,
  });
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(apiUrl(path))
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((d) => {
          if (!alive) return;
          setState({
            data: Array.isArray(d) ? d : [],
            loaded: true,
            error: false,
            updatedAt: new Date(),
          });
        })
        .catch(() => {
          if (alive) setState((s) => ({ ...s, loaded: true, error: true }));
        });
    load();
    const timer = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, refreshMs]);
  return state;
}

function useHealth(refreshMs = 10000): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(apiUrl("/health"))
        .then((r) => {
          if (alive) setOnline(r.ok);
        })
        .catch(() => {
          if (alive) setOnline(false);
        });
    load();
    const timer = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refreshMs]);
  return online;
}

function useConfig(): PublicConfig | null {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(apiUrl("/v1/config/public"))
      .then((r) => r.json())
      .then((d) => {
        if (alive) setConfig(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return config;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duration(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms <= 0) return "—";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const styles: Record<string, string> = {
    booked:
      "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]",
    info_only:
      "bg-[#fffbeb] border-[#fde68a] text-[#b45309]",
    in_progress:
      "bg-[#eff6ff] border-[#bfdbfe] text-[#1d4ed8]",
  };
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border",
        styles[outcome] ?? "bg-[#fafafa] border-[#e7e7e7] text-[#4e505b]"
      )}
    >
      {outcome}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    booked:
      "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]",
    completed:
      "bg-[#eff6ff] border-[#bfdbfe] text-[#1d4ed8]",
    cancelled:
      "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]",
  };
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border",
        styles[status] ?? "bg-[#fafafa] border-[#e7e7e7] text-[#4e505b]"
      )}
    >
      {status}
    </span>
  );
}

function StatCard({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="rounded-lg border border-[#e7e7e7] bg-white p-3 sm:p-4 min-w-[120px] flex-1 shadow-xs">
      <div className="text-[20px] sm:text-[24px] font-semibold text-[#0a0a0a] leading-none">
        {value}
      </div>
      <div className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider text-[#4e505b] mt-1.5 sm:mt-2">
        {label}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#e7e7e7] bg-white overflow-hidden shadow-xs">
      <h2 className="text-[12px] font-semibold text-[#0a0a0a] px-3 sm:px-4 py-2 sm:py-2.5 border-b border-[#e7e7e7] bg-[#fafafa]">
        {title}
      </h2>
      <div className="overflow-x-auto w-full">
        {children}
      </div>
    </div>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <tr key={i} className="border-t border-[#e7e7e7]">
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-4 py-2.5">
              <div className="h-3 w-3/4 rounded bg-[#f4f4f5]" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function CallsTable({
  calls,
  loading,
}: {
  calls: CallRecord[];
  loading?: boolean;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (loading) return <SkeletonRows cols={4} />;
  if (calls.length === 0)
    return <Empty text="No call records yet." />;
  return (
    <table className="w-full min-w-[540px] text-left">
      <thead>
        <tr className="text-[11px] font-semibold uppercase tracking-wider text-[#4e505b] bg-[#fafafa] border-b border-[#e7e7e7]">
          <th className="px-4 py-2">Timestamp</th>
          <th className="px-4 py-2">Outcome</th>
          <th className="px-4 py-2">Caller Phone</th>
          <th className="px-4 py-2">Transcript Summary</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#e7e7e7]">
        {calls.map((c) => (
          <CallRow
            key={c.id}
            call={c}
            expanded={expanded === c.id}
            onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
          />
        ))}
      </tbody>
    </table>
  );
}

function CallRow({
  call,
  expanded,
  onToggle,
}: {
  call: CallRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer hover:bg-[#fafafa] transition-colors duration-150 text-[12px]"
      >
        <td className="px-4 py-2.5 whitespace-nowrap text-[#0a0a0a]">{fmt(call.started_at)}</td>
        <td className="px-4 py-2.5">
          <OutcomeBadge outcome={call.outcome} />
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap font-mono text-[11px] text-[#4e505b]">
          {call.caller_phone ?? "—"}
        </td>
        <td className="px-4 py-2.5 text-[#4e505b] max-w-[280px]">
          <span className="flex items-center justify-between gap-1">
            <span className="truncate">{call.transcript_summary ?? "—"}</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform duration-150 text-[#4e505b]",
                expanded && "rotate-180"
              )}
            />
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-[#fafafa] text-[12px]">
          <td colSpan={4} className="px-4 py-3">
            <div className="text-[12px] text-[#0a0a0a] whitespace-pre-wrap break-words leading-relaxed">
              {call.transcript_summary ?? "No summary recorded for this call."}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-[#4e505b]">
              <span>Room: {call.room_name}</span>
              <span>Duration: {duration(call.started_at, call.ended_at)}</span>
              {call.ended_at && <span>Ended: {fmt(call.ended_at)}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AppointmentsTable({
  appointments,
  loading,
}: {
  appointments: Appointment[];
  loading?: boolean;
}) {
  if (loading) return <SkeletonRows cols={4} />;
  if (appointments.length === 0)
    return <Empty text="No appointments scheduled yet." />;
  return (
    <table className="w-full min-w-[540px] text-left">
      <thead>
        <tr className="text-[11px] font-semibold uppercase tracking-wider text-[#4e505b] bg-[#fafafa] border-b border-[#e7e7e7]">
          <th className="px-4 py-2">Scheduled For</th>
          <th className="px-4 py-2">Service</th>
          <th className="px-4 py-2">Status</th>
          <th className="px-4 py-2">Customer</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#e7e7e7]">
        {appointments.map((a) => (
          <tr
            key={a.id}
            className="hover:bg-[#fafafa] transition-colors duration-150 text-[12px]"
          >
            <td className="px-4 py-2.5 whitespace-nowrap text-[#0a0a0a]">
              {fmt(a.scheduled_for)}
            </td>
            <td className="px-4 py-2.5 text-[#0a0a0a]">
              {a.service}
              {a.notes && (
                <div className="text-[11px] text-[#4e505b] truncate max-w-[220px]">
                  {a.notes}
                </div>
              )}
            </td>
            <td className="px-4 py-2.5">
              <StatusBadge status={a.status} />
            </td>
            <td className="px-4 py-2.5">
              <div className="text-[#0a0a0a] font-medium">{a.customer_name ?? "—"}</div>
              <div className="text-[11px] font-mono text-[#4e505b]">
                {a.customer_phone}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="px-4 py-8 text-center text-[12px] text-[#4e505b]">
      {text}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-8">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#e7e7e7] border-t-[#0b5ed7]" />
    </div>
  );
}

function ConfigValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return (
      <ul className="list-disc pl-4 space-y-1">
        {value.map((v, i) => (
          <li key={i} className="text-[#0a0a0a]">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </li>
        ))}
      </ul>
    );
  }
  if (value && typeof value === "object") {
    return (
      <ul className="space-y-1">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <li key={k} className="flex gap-2">
            <span className="capitalize w-24 shrink-0 font-medium text-[#4e505b]">{k}</span>
            <span className="text-[#0a0a0a]">
              {String(v).toLowerCase() === "closed" ? "Closed" : String(v)}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return <span className="text-[#0a0a0a]">{String(value)}</span>;
}

function SettingsPage({ config }: { config: PublicConfig | null }) {
  if (!config) return <Spinner />;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="space-y-1">
        <h2 className="text-[14px] font-semibold text-[#0a0a0a]">
          Business Operations &amp; Safety Parameters
        </h2>
        <p className="text-[12px] text-[#4e505b]">
          Runtime parameters consumed by the agent worker and appointment scheduler.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Company Profile Card */}
        <div className="rounded-lg border border-[#e7e7e7] bg-white overflow-hidden shadow-xs">
          <div className="px-4 py-2.5 border-b border-[#e7e7e7] bg-[#fafafa] text-[12px] font-semibold text-[#0a0a0a]">
            Company Profile &amp; Contact
          </div>
          <dl className="divide-y divide-[#e7e7e7] text-[12px]">
            <div className="px-4 py-2.5 flex justify-between gap-3">
              <dt className="text-[#4e505b]">Company Name</dt>
              <dd className="font-medium text-[#0a0a0a]">{config.company_name || "—"}</dd>
            </div>
            <div className="px-4 py-2.5 flex justify-between gap-3">
              <dt className="text-[#4e505b]">Primary Phone</dt>
              <dd className="font-mono text-[#0a0a0a]">{config.phone || "—"}</dd>
            </div>
            <div className="px-4 py-2.5 flex justify-between gap-3">
              <dt className="text-[#4e505b]">Emergency Phone</dt>
              <dd className="font-mono text-[#e11d48] font-semibold">{config.emergency_phone || "—"}</dd>
            </div>
            <div className="px-4 py-2.5 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-3">
              <dt className="text-[#4e505b]">Service Address</dt>
              <dd className="sm:text-right text-[#0a0a0a]">{config.address || "—"}</dd>
            </div>
            <div className="px-4 py-2.5 flex justify-between gap-3">
              <dt className="text-[#4e505b]">Timezone</dt>
              <dd className="font-mono text-[#0a0a0a]">{config.timezone || "—"}</dd>
            </div>
          </dl>
        </div>

        {/* Operating Hours Card */}
        <div className="rounded-lg border border-[#e7e7e7] bg-white overflow-hidden shadow-xs">
          <div className="px-4 py-2.5 border-b border-[#e7e7e7] bg-[#fafafa] text-[12px] font-semibold text-[#0a0a0a]">
            Weekly Operating Schedule
          </div>
          <div className="divide-y divide-[#e7e7e7] text-[12px]">
            {config.opening_hours &&
              Object.entries(config.opening_hours).map(([day, hours]) => (
                <div key={day} className="px-4 py-2 flex items-center justify-between">
                  <span className="capitalize font-medium text-[#4e505b]">{day}</span>
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      String(hours).toLowerCase() === "closed"
                        ? "text-[#a1a1aa] italic"
                        : "text-[#0a0a0a] font-semibold"
                    )}
                  >
                    {String(hours).toLowerCase() === "closed" ? "Closed" : String(hours)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Services Catalog */}
      <div className="rounded-lg border border-[#e7e7e7] bg-white p-4 space-y-3 shadow-xs">
        <div className="text-[12px] font-semibold text-[#0a0a0a]">
          Approved HVAC Services
        </div>
        <div className="flex flex-wrap gap-2">
          {config.services && config.services.length > 0 ? (
            config.services.map((svc) => (
              <span
                key={svc}
                className="px-2.5 py-1 text-[11px] font-mono rounded-full border border-[#e7e7e7] bg-[#fafafa] text-[#0a0a0a]"
              >
                {svc}
              </span>
            ))
          ) : (
            <span className="text-[12px] text-[#4e505b]">No services configured.</span>
          )}
        </div>
      </div>
    </div>
  );
}

function CallsPage({ calls }: { calls: ApiState<CallRecord> }) {
  const [filter, setFilter] = useState<"all" | "booked" | "info_only">("all");

  const filtered = calls.data.filter((c) => {
    if (filter === "booked") return c.outcome === "booked";
    if (filter === "info_only") return c.outcome === "info_only";
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="text-[14px] font-semibold text-[#0a0a0a]">
            Inbound Call Records
          </h2>
          <p className="text-[12px] text-[#4e505b]">
            Full transcript summaries, outcomes, and durations recorded in SQLite.
          </p>
        </div>

        <div className="flex items-center gap-1 p-0.5 rounded-md border border-[#e7e7e7] bg-[#fafafa]">
          {(["all", "booked", "info_only"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={cn(
                "px-2.5 py-1 text-[11px] font-medium rounded capitalize transition-colors duration-150 cursor-pointer",
                filter === t
                  ? "bg-white text-[#0a0a0a] border border-[#e7e7e7] font-semibold shadow-xs"
                  : "text-[#4e505b] hover:text-[#0a0a0a]"
              )}
            >
              {t.replace("_", " ")} ({t === "all" ? calls.data.length : calls.data.filter((c) => c.outcome === t).length})
            </button>
          ))}
        </div>
      </div>

      <Card title={`Calls Log (${filtered.length})`}>
        <CallsTable calls={filtered} loading={!calls.loaded} />
      </Card>
    </div>
  );
}

function AppointmentsPage({ appointments }: { appointments: ApiState<Appointment> }) {
  const [viewMode, setViewMode] = useState<"calendar" | "table">("calendar");

  const calendarData: CalendarData[] = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const a of appointments.data) {
      if (!a.scheduled_for) continue;
      const d = new Date(a.scheduled_for);
      if (isNaN(d.getTime())) continue;
      const key = format(d, "yyyy-MM-dd");
      const ev: CalendarEvent = {
        id: a.id,
        name: `${a.service}${a.customer_name ? ` · ${a.customer_name}` : ""}`,
        time: format(d, "h:mm a"),
        datetime: a.scheduled_for,
        customerName: a.customer_name,
        customerPhone: a.customer_phone,
        status: a.status,
        notes: a.notes,
      };
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    return Array.from(map.entries()).map(([key, events]) => ({
      day: parse(key, "yyyy-MM-dd", new Date()),
      events,
    }));
  }, [appointments.data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="text-[14px] font-semibold text-[#0a0a0a]">
            Scheduled Appointments
          </h2>
          <p className="text-[12px] text-[#4e505b]">
            Upcoming technician dispatches booked through the voice receptionist engine.
          </p>
        </div>

        {/* View Switcher Tabs */}
        <div className="flex items-center gap-1 p-0.5 rounded-md border border-[#e7e7e7] bg-[#fafafa]">
          <button
            type="button"
            onClick={() => setViewMode("calendar")}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded transition-colors duration-150 cursor-pointer",
              viewMode === "calendar"
                ? "bg-white text-[#0a0a0a] border border-[#e7e7e7] font-semibold shadow-xs"
                : "text-[#4e505b] hover:text-[#0a0a0a]"
            )}
          >
            <CalendarDays className="w-3.5 h-3.5" />
            <span>Calendar View</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode("table")}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded transition-colors duration-150 cursor-pointer",
              viewMode === "table"
                ? "bg-white text-[#0a0a0a] border border-[#e7e7e7] font-semibold shadow-xs"
                : "text-[#4e505b] hover:text-[#0a0a0a]"
            )}
          >
            <TableIcon className="w-3.5 h-3.5" />
            <span>Table View ({appointments.data.length})</span>
          </button>
        </div>
      </div>

      {viewMode === "calendar" ? (
        <FullScreenCalendar data={calendarData} />
      ) : (
        <Card title={`All Scheduled Appointments (${appointments.data.length})`}>
          <AppointmentsTable
            appointments={appointments.data}
            loading={!appointments.loaded}
          />
        </Card>
      )}
    </div>
  );
}

function DashboardPage({
  calls,
  appointments,
  loading,
  onNavigate,
}: {
  calls: ApiState<CallRecord>;
  appointments: ApiState<Appointment>;
  loading: boolean;
  onNavigate: (page: Page) => void;
}) {
  const bookedCount = calls.data.filter((c) => c.outcome === "booked").length;
  const rate = calls.data.length > 0 ? Math.round((bookedCount / calls.data.length) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <StatCard
          value={loading ? "—" : calls.data.length}
          label="Total Calls"
        />
        <StatCard
          value={loading ? "—" : bookedCount}
          label="Appointments Booked"
        />
        <StatCard
          value={loading ? "—" : appointments.data.length}
          label="Upcoming Visits"
        />
        <StatCard
          value={loading ? "—" : `${rate}%`}
          label="Booking Rate"
        />
      </div>

      {/* Two-Column Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[12px] font-semibold text-[#0a0a0a]">
              Recent Interactions
            </span>
            <button
              onClick={() => onNavigate("calls")}
              className="text-[11px] font-medium text-[#0b5ed7] hover:underline cursor-pointer"
            >
              View all calls →
            </button>
          </div>
          <Card title="Recent Calls">
            <CallsTable calls={calls.data.slice(0, 6)} loading={loading} />
          </Card>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[12px] font-semibold text-[#0a0a0a]">
              Upcoming Appointments
            </span>
            <button
              onClick={() => onNavigate("appointments")}
              className="text-[11px] font-medium text-[#0b5ed7] hover:underline cursor-pointer"
            >
              View all appointments →
            </button>
          </div>
          <Card title="Confirmed Schedule">
            <AppointmentsTable
              appointments={appointments.data.slice(0, 6)}
              loading={loading}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const calls = useApi<CallRecord>("/v1/calls");
  const appointments = useApi<Appointment>("/v1/appointments");
  const online = useHealth();
  const config = useConfig();
  const [page, setPage] = useState<Page>("dashboard");
  const [open, setOpen] = useState(false);

  const updatedAt =
    calls.updatedAt && appointments.updatedAt
      ? calls.updatedAt > appointments.updatedAt
        ? calls.updatedAt
        : appointments.updatedAt
      : calls.updatedAt ?? appointments.updatedAt;
  const loading = !calls.loaded || !appointments.loaded;
  const apiError = calls.error || appointments.error;

  const links: {
    page: Page;
    label: string;
    href: string;
    icon: React.ReactNode;
  }[] = [
    {
      page: "dashboard",
      label: "Dashboard",
      href: "#dashboard",
      icon: <LayoutDashboard className="h-4 w-4 flex-shrink-0" />,
    },
    {
      page: "live-call",
      label: "Live Call",
      href: "#live-call",
      icon: <Radio className="h-4 w-4 flex-shrink-0 text-[#0b5ed7]" />,
    },
    {
      page: "calls",
      label: "Calls",
      href: "#calls",
      icon: <PhoneCall className="h-4 w-4 flex-shrink-0" />,
    },
    {
      page: "appointments",
      label: "Appointments",
      href: "#appointments",
      icon: <CalendarCheck className="h-4 w-4 flex-shrink-0" />,
    },
    {
      page: "settings",
      label: "Settings",
      href: "#settings",
      icon: <Settings className="h-4 w-4 flex-shrink-0" />,
    },
  ];

  return (
    <div className="relative flex flex-col md:flex-row h-screen w-full overflow-hidden bg-white text-[#0a0a0a]">
      <Sidebar open={open} setOpen={setOpen}>
        <SidebarBody className="justify-between gap-6 border-r border-[#e7e7e7] bg-white">
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden">
            <Logo
              showText={open}
              onNavigate={() => {
                setPage("dashboard");
                setOpen(false);
              }}
            />
            <div className="mt-6 flex flex-col gap-1">
              {links.map((link) => (
                <SidebarLink
                  key={link.page}
                  link={{
                    label: link.label,
                    href: link.href,
                    icon: (
                      <span
                        className={cn(
                          "flex-shrink-0",
                          page === link.page
                            ? "text-[#0b5ed7]"
                            : "text-[#4e505b]"
                        )}
                      >
                        {link.icon}
                      </span>
                    ),
                    onClick: () => {
                      setPage(link.page);
                      setOpen(false);
                    },
                  }}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150",
                    page === link.page
                      ? "bg-[#f4f4f5] text-[#0a0a0a] border border-[#e7e7e7] font-semibold"
                      : "text-[#4e505b] hover:bg-[#fafafa] hover:text-[#0a0a0a]"
                  )}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 px-2 py-3 text-[11px] font-mono text-[#4e505b] border-t border-[#e7e7e7]">
            <PhoneIncoming className="h-4 w-4 flex-shrink-0" />
            <motion.span
              animate={{
                display: open ? "inline-block" : "none",
                opacity: open ? 1 : 0,
              }}
              className="whitespace-pre"
            >
              HVAC Receptionist
            </motion.span>
          </div>
        </SidebarBody>
      </Sidebar>

      <main className="flex-1 min-h-0 min-w-0 overflow-y-auto bg-white">
        <div className="p-3 sm:p-5 md:p-7 min-h-full bg-white border-l-0 md:border-l border-[#e7e7e7]">
          <header className="mb-4 sm:mb-6 pb-3 sm:pb-4 border-b border-[#e7e7e7] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight text-[#0a0a0a] capitalize">
                {page === "live-call" ? "Live Call Console" : page}
              </h1>
              <p className="text-[12px] text-[#4e505b]">
                {config?.company_name ?? "HVAC Receptionist"}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-[11px] text-[#4e505b] px-2.5 py-1 rounded-md border border-[#e7e7e7] bg-[#fafafa]">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    online === null && "bg-[#a1a1aa]",
                    online === true && "bg-emerald-500",
                    online === false && "bg-rose-500"
                  )}
                />
                <span>
                  {online === null
                    ? "connecting…"
                    : online
                      ? "API online"
                      : "API offline"}
                </span>
                {updatedAt && (
                  <span className="text-neutral-500">
                    · updated {updatedAt.toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
          </header>

          {apiError && (
            <div className="mb-4 rounded-md border border-[#fde68a] bg-[#fffbeb] px-4 py-2.5 text-[12px] text-[#b45309]">
              Connecting to backend API… If the free server was idle, it takes ~30–50s to wake up. Retrying automatically.
            </div>
          )}

          {page === "dashboard" && (
            <DashboardPage
              calls={calls}
              appointments={appointments}
              loading={loading}
              onNavigate={(p) => setPage(p)}
            />
          )}
          {page === "live-call" && (
            <LiveCallPage onNavigateToCalls={() => setPage("calls")} />
          )}
          {page === "calls" && <CallsPage calls={calls} />}
          {page === "appointments" && <AppointmentsPage appointments={appointments} />}
          {page === "settings" && <SettingsPage config={config} />}
        </div>
      </main>
    </div>
  );
}

function Logo({ showText, onNavigate }: { showText: boolean; onNavigate: () => void }) {
  return (
    <a
      href="#dashboard"
      onClick={(e) => {
        e.preventDefault();
        onNavigate();
      }}
      className="flex items-center gap-2.5 py-1 px-1 relative z-20 text-[13px] font-semibold text-[#0a0a0a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] rounded-md"
    >
      <Avatar className="h-6 w-6 border border-[#e7e7e7] shrink-0">
        <AvatarImage
          src="https://cdn.21st.dev/assets/mirror/ec/ec81be4cc810190ce4d240fcc57295965c5cebaa8751558595ade91eb62c09a4.png"
          alt="Hallie Richards"
        />
        <AvatarFallback className="text-[10px] font-semibold text-[#4e505b]">HR</AvatarFallback>
      </Avatar>
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: showText ? 1 : 0 }}
        className="font-semibold tracking-tight text-[#0a0a0a] whitespace-pre"
      >
        HVAC Receptionist
      </motion.span>
    </a>
  );
}
