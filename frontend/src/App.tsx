import { useEffect, useState } from "react";
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
  Sun,
  Moon,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/api";
import AtcShader from "@/components/ui/atc-shader";

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

type Page = "dashboard" | "calls" | "appointments" | "settings";

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
    booked: "bg-green-900/60 text-green-400",
    info_only: "bg-amber-900/60 text-amber-400",
    in_progress: "bg-sky-900/60 text-sky-400",
  };
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold",
        styles[outcome] ?? "bg-neutral-700 text-neutral-300"
      )}
    >
      {outcome}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    booked: "bg-green-900/60 text-green-400",
    completed: "bg-sky-900/60 text-sky-400",
    cancelled: "bg-red-900/60 text-red-400",
  };
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold",
        styles[status] ?? "bg-neutral-700 text-neutral-300"
      )}
    >
      {status}
    </span>
  );
}

function StatCard({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white/90 dark:bg-neutral-950/60 backdrop-blur-sm p-5 min-w-[150px]">
      <div className="text-3xl font-bold text-sky-500">{value}</div>
      <div className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
        {label}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white/90 dark:bg-neutral-950/60 backdrop-blur-sm overflow-hidden">
      <h2 className="text-sm font-semibold text-sky-500 px-5 py-3 border-b border-neutral-200 dark:border-neutral-700">
        {title}
      </h2>
      {children}
    </div>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <tr key={i} className="border-t border-neutral-200 dark:border-neutral-800">
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-5 py-3">
              <div className="h-3.5 w-3/4 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
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
    return <Empty text="No calls yet — make one from the LiveKit Playground!" />;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase text-neutral-500 dark:text-neutral-400">
          <th className="px-5 py-2">When</th>
          <th className="px-5 py-2">Outcome</th>
          <th className="px-5 py-2">Phone</th>
          <th className="px-5 py-2">Summary</th>
        </tr>
      </thead>
      <tbody>
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
        className="border-t border-neutral-200 dark:border-neutral-800 cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
      >
        <td className="px-5 py-2.5 whitespace-nowrap">{fmt(call.started_at)}</td>
        <td className="px-5 py-2.5">
          <OutcomeBadge outcome={call.outcome} />
        </td>
        <td className="px-5 py-2.5 whitespace-nowrap font-mono text-xs">
          {call.caller_phone ?? "—"}
        </td>
        <td className="px-5 py-2.5 text-neutral-500 dark:text-neutral-400 max-w-[280px]">
          <span className="flex items-center gap-1">
            <span className="truncate">{call.transcript_summary ?? "—"}</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                expanded && "rotate-180"
              )}
            />
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-800/40">
          <td colSpan={4} className="px-5 py-3">
            <div className="text-xs text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap break-words">
              {call.transcript_summary ?? "No summary recorded for this call."}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400 dark:text-neutral-500">
              <span>room: {call.room_name}</span>
              <span>duration: {duration(call.started_at, call.ended_at)}</span>
              {call.ended_at && <span>ended: {fmt(call.ended_at)}</span>}
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
    return <Empty text="No appointments booked yet." />;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase text-neutral-500 dark:text-neutral-400">
          <th className="px-5 py-2">When</th>
          <th className="px-5 py-2">Service</th>
          <th className="px-5 py-2">Status</th>
          <th className="px-5 py-2">Customer</th>
        </tr>
      </thead>
      <tbody>
        {appointments.map((a) => (
          <tr
            key={a.id}
            className="border-t border-neutral-200 dark:border-neutral-800"
          >
            <td className="px-5 py-2.5 whitespace-nowrap">
              {fmt(a.scheduled_for)}
            </td>
            <td className="px-5 py-2.5">
              {a.service}
              {a.notes && (
                <div className="text-xs text-neutral-400 dark:text-neutral-500 truncate max-w-[220px]">
                  {a.notes}
                </div>
              )}
            </td>
            <td className="px-5 py-2.5">
              <StatusBadge status={a.status} />
            </td>
            <td className="px-5 py-2.5">
              {a.customer_name ?? "—"}
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
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
    <div className="px-5 py-8 text-neutral-500 dark:text-neutral-400 italic">
      {text}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-10">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-sky-500 dark:border-neutral-600 dark:border-t-sky-500" />
    </div>
  );
}

function ConfigValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return (
      <ul className="list-disc pl-4 space-y-0.5">
        {value.map((v, i) => (
          <li key={i}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</li>
        ))}
      </ul>
    );
  }
  if (value && typeof value === "object") {
    return (
      <ul className="space-y-0.5">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <li key={k} className="flex gap-2">
            <span className="capitalize w-24 shrink-0">{k}</span>
            <span className="text-neutral-500 dark:text-neutral-400">
              {String(v).toLowerCase() === "closed" ? "Closed" : String(v)}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return <>{String(value)}</>;
}

function SettingsPage({ config }: { config: PublicConfig | null }) {
  if (!config) return <Spinner />;
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white/90 dark:bg-neutral-950/60 backdrop-blur-sm p-6 max-w-xl">
      <h2 className="text-lg font-semibold mb-4">Business Configuration</h2>
      <dl className="space-y-3 text-sm">
        {Object.entries(config).map(([key, value]) => (
          <div key={key} className="flex gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400 w-40 shrink-0 capitalize">
              {key.replace(/_/g, " ")}
            </dt>
            <dd className="font-medium break-all">
              <ConfigValue value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DashboardPage({
  calls,
  appointments,
  loading,
}: {
  calls: ApiState<CallRecord>;
  appointments: ApiState<Appointment>;
  loading: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3 flex-wrap">
        <StatCard
          value={loading ? "—" : calls.data.length}
          label="Calls (recent)"
        />
        <StatCard
          value={loading ? "—" : calls.data.filter((c) => c.outcome === "booked").length}
          label="Booked calls"
        />
        <StatCard value={loading ? "—" : appointments.data.length} label="Appointments" />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Recent Calls">
          <CallsTable calls={calls.data.slice(0, 8)} loading={loading} />
        </Card>
        <Card title="Upcoming Appointments">
          <AppointmentsTable
            appointments={appointments.data.slice(0, 8)}
            loading={loading}
          />
        </Card>
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
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("theme") === "light" ? "light" : "dark"
  );
  useEffect(() => {
    localStorage.setItem("theme", theme);
  }, [theme]);

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
      icon: <LayoutDashboard className="h-5 w-5 flex-shrink-0" />,
    },
    {
      page: "calls",
      label: "Calls",
      href: "#calls",
      icon: <PhoneCall className="h-5 w-5 flex-shrink-0" />,
    },
    {
      page: "appointments",
      label: "Appointments",
      href: "#appointments",
      icon: <CalendarCheck className="h-5 w-5 flex-shrink-0" />,
    },
    {
      page: "settings",
      label: "Settings",
      href: "#settings",
      icon: <Settings className="h-5 w-5 flex-shrink-0" />,
    },
  ];

  return (
    <div
      className={cn(
        "relative flex h-screen w-full overflow-hidden text-neutral-900 dark:text-neutral-100",
        theme === "dark" && "dark"
      )}
    >
      <AtcShader />
      <Sidebar open={open} setOpen={setOpen}>
        <SidebarBody className="justify-between gap-10">
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden">
            <Logo showText={open} onNavigate={() => setPage("dashboard")} />
            <div className="mt-8 flex flex-col gap-1">
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
                            ? "text-sky-400"
                            : "text-neutral-700 dark:text-neutral-200"
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
                    "rounded-lg px-2 transition-colors duration-150",
                    page === link.page &&
                      "bg-sky-500/10 hover:bg-sky-500/15"
                  )}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-neutral-500 dark:text-neutral-400">
            <PhoneIncoming className="h-5 w-5 flex-shrink-0" />
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

      <main className="flex-1 overflow-y-auto">
        <div className="p-4 md:p-10 min-h-full rounded-tl-2xl border border-neutral-200 dark:border-neutral-700 bg-neutral-100/90 dark:bg-neutral-950/55 backdrop-blur-sm">
          <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold capitalize">{page}</h1>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {config?.company_name ?? "HVAC Receptionist"}
              </p>
            </div>
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-2 text-neutral-500 dark:text-neutral-300 hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60 transition-colors"
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>
            <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  online === null && "bg-neutral-400 animate-pulse",
                  online === true && "bg-green-500",
                  online === false && "bg-red-500"
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
                <span className="text-neutral-400 dark:text-neutral-500">
                  · updated {updatedAt.toLocaleTimeString()}
                </span>
              )}
            </div>
          </header>

          {apiError && (
            <div className="mb-4 rounded-lg border border-red-800 bg-red-950/60 px-4 py-2 text-sm text-red-400">
              Can&apos;t reach the API — check that the backend is running on
              port 8000. Retrying automatically.
            </div>
          )}

          {page === "dashboard" && (
            <DashboardPage
              calls={calls}
              appointments={appointments}
              loading={loading}
            />
          )}
          {page === "calls" && (
            <Card title="All Calls">
              <CallsTable calls={calls.data} loading={!calls.loaded} />
            </Card>
          )}
          {page === "appointments" && (
            <Card title="All Appointments">
              <AppointmentsTable
                appointments={appointments.data}
                loading={!appointments.loaded}
              />
            </Card>
          )}
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
      className="font-normal flex space-x-2 items-center text-sm py-1 relative z-20"
    >
      <div className="h-5 w-6 bg-neutral-900 dark:bg-white rounded-br-lg rounded-tr-sm rounded-tl-lg rounded-bl-sm flex-shrink-0" />
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: showText ? 1 : 0 }}
        className="font-medium text-neutral-900 dark:text-white whitespace-pre"
      >
        HVAC Labs
      </motion.span>
    </a>
  );
}
