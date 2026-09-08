"use client";

import React, { useState, useMemo } from "react";
import {
  format,
  addDays,
  startOfToday,
  isSameDay,
  isToday,
} from "date-fns";
import {
  Calendar as CalendarIcon,
  Clock,
  Phone,
  User,
  ChevronRight,
  FileText,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn, cleanTelHref } from "@/lib/utils";

export interface MobileAppointment {
  id: number;
  service: string;
  scheduled_for: string;
  status: string;
  notes: string | null;
  customer_name: string | null;
  customer_phone: string;
}

interface MobileAgendaViewProps {
  appointments: MobileAppointment[];
  loading?: boolean;
}

export function MobileAgendaView({
  appointments,
  loading = false,
}: MobileAgendaViewProps) {
  const today = startOfToday();
  const [selectedDate, setSelectedDate] = useState<Date>(today);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Generate 14-day rolling window for horizontal strip
  const dateStrip = useMemo(() => {
    return Array.from({ length: 14 }).map((_, i) => addDays(today, i - 1)); // yesterday to +12 days
  }, [today]);

  // Group appointments by date string (yyyy-MM-dd)
  const apptMap = useMemo(() => {
    const map = new Map<string, MobileAppointment[]>();
    for (const appt of appointments) {
      if (!appt.scheduled_for) continue;
      const d = new Date(appt.scheduled_for);
      if (isNaN(d.getTime())) continue;
      const key = format(d, "yyyy-MM-dd");
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(appt);
    }
    return map;
  }, [appointments]);

  const selectedKey = format(selectedDate, "yyyy-MM-dd");
  const selectedEvents = apptMap.get(selectedKey) || [];

  return (
    <div className="space-y-4">
      {/* 1. Horizontal Day Selector Strip */}
      <div className="rounded-xl border border-[#e7e7e7] bg-white p-2.5 shadow-xs">
        <div className="flex items-center justify-between px-1 pb-2 border-b border-[#f4f4f5]">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#0a0a0a]">
            <CalendarIcon className="w-3.5 h-3.5 text-[#0b5ed7]" aria-hidden="true" />
            <span>{format(selectedDate, "MMMM yyyy")}</span>
          </div>
          {!isSameDay(selectedDate, today) && (
            <button
              type="button"
              onClick={() => setSelectedDate(today)}
              className="text-[11px] font-medium text-[#0b5ed7] hover:underline cursor-pointer"
            >
              Back to Today
            </button>
          )}
        </div>

        {/* Scrollable Day Pills */}
        <div className="flex gap-1.5 overflow-x-auto py-2 px-0.5 no-scrollbar scroll-smooth">
          {dateStrip.map((day) => {
            const isSelected = isSameDay(day, selectedDate);
            const isCurrentToday = isToday(day);
            const key = format(day, "yyyy-MM-dd");
            const dayAppts = apptMap.get(key) || [];
            const hasAppts = dayAppts.length > 0;

            return (
              <motion.button
                key={day.toISOString()}
                type="button"
                whileTap={{ scale: 0.94 }}
                onClick={() => setSelectedDate(day)}
                className={cn(
                  "flex flex-col items-center justify-center min-w-[48px] py-2 px-1.5 rounded-lg border text-center transition-all duration-150 cursor-pointer shrink-0",
                  isSelected
                    ? "bg-[#0a0a0a] text-white border-[#0a0a0a] shadow-xs"
                    : isCurrentToday
                    ? "bg-[#eff6ff] text-[#0b5ed7] border-[#bfdbfe]"
                    : "bg-[#fafafa] text-[#4e505b] border-[#e7e7e7] hover:bg-white"
                )}
              >
                <span className="text-[10px] font-mono uppercase tracking-wider">
                  {format(day, "EEE")}
                </span>
                <span
                  className={cn(
                    "text-[15px] font-semibold mt-0.5 leading-none font-mono tabular-nums",
                    isSelected ? "text-white" : isCurrentToday ? "text-[#0b5ed7]" : "text-[#0a0a0a]"
                  )}
                >
                  {format(day, "d")}
                </span>

                {/* Dot indicator for bookings */}
                <div className="h-1.5 flex items-center gap-0.5 mt-1">
                  {hasAppts && (
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        isSelected ? "bg-white" : "bg-[#0b5ed7]"
                      )}
                    />
                  )}
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* 2. Agenda List Header */}
      <div className="flex items-center justify-between px-1">
        <div className="space-y-0.5">
          <h3 className="text-[13px] font-semibold text-[#0a0a0a]">
            {isToday(selectedDate)
              ? "Today's Dispatch Agenda"
              : format(selectedDate, "EEEE, MMMM d")}
          </h3>
          <p className="text-[11px] font-mono tabular-nums text-[#71717a]">
            {selectedEvents.length} {selectedEvents.length === 1 ? "appointment" : "appointments"} scheduled
          </p>
        </div>
      </div>

      {/* 3. Appointment Cards Feed */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((n) => (
            <div
              key={n}
              className="h-24 rounded-xl border border-[#e7e7e7] bg-white p-4 animate-pulse"
            />
          ))}
        </div>
      ) : selectedEvents.length === 0 ? (
        <div className="rounded-xl border border-[#e7e7e7] bg-white p-8 text-center space-y-2 shadow-xs">
          <div className="w-10 h-10 rounded-full bg-[#f4f4f5] border border-[#e7e7e7] flex items-center justify-center mx-auto text-[#71717a]">
            <CalendarIcon className="w-5 h-5" aria-hidden="true" />
          </div>
          <p className="text-[13px] font-medium text-[#0a0a0a]">
            No appointments on this date
          </p>
          <p className="text-[11px] text-[#71717a] max-w-xs mx-auto">
            The voice receptionist hasn't scheduled any technician visits for {format(selectedDate, "MMM d")}.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {selectedEvents.map((appt) => {
            const timeStr = appt.scheduled_for
              ? format(new Date(appt.scheduled_for), "h:mm a")
              : "—";
            const isExpanded = expandedId === appt.id;

            return (
              <motion.div
                key={appt.id}
                layout
                className="rounded-xl border border-[#e7e7e7] bg-white p-3.5 space-y-3 shadow-xs transition-shadow duration-150"
              >
                {/* Header: Time, Service, Status */}
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 font-mono tabular-nums text-[12px] font-semibold text-[#0a0a0a] bg-[#f4f4f5] px-2 py-0.5 rounded-md border border-[#e7e7e7]">
                        <Clock className="w-3 h-3 text-[#71717a]" aria-hidden="true" />
                        {timeStr}
                      </span>
                      <span
                        className={cn(
                          "text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border",
                          appt.status === "booked"
                            ? "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]"
                            : appt.status === "completed"
                            ? "bg-[#eff6ff] border-[#bfdbfe] text-[#1d4ed8]"
                            : "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
                        )}
                      >
                        {appt.status}
                      </span>
                    </div>

                    <h4 className="text-[14px] font-semibold text-[#0a0a0a] tracking-tight">
                      {appt.service}
                    </h4>
                  </div>
                </div>

                {/* Customer Details & 1-Tap Dial Action */}
                <div className="flex items-center justify-between pt-2 border-t border-[#f4f4f5] gap-3">
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-1.5 text-[12px] font-medium text-[#0a0a0a] truncate">
                      <User className="w-3.5 h-3.5 text-[#71717a] shrink-0" aria-hidden="true" />
                      <span className="truncate">{appt.customer_name || "Customer"}</span>
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-[#71717a]">
                      {appt.customer_phone}
                    </div>
                  </div>

                  {/* 1-Tap Call Customer Button */}
                  <a
                    href={cleanTelHref(appt.customer_phone)}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold bg-[#eff6ff] hover:bg-[#dbeafe] text-[#0b5ed7] border border-[#bfdbfe] transition-colors duration-150 cursor-pointer shrink-0 shadow-2xs active:scale-95"
                    aria-label={`Call customer ${appt.customer_name || ""}`}
                  >
                    <Phone className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Call</span>
                  </a>
                </div>

                {/* Optional Notes Toggle */}
                {appt.notes && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : appt.id)}
                      className="inline-flex items-center gap-1 text-[11px] text-[#71717a] hover:text-[#0a0a0a] transition-colors cursor-pointer"
                    >
                      <FileText className="w-3 h-3" aria-hidden="true" />
                      <span>{isExpanded ? "Hide notes" : "View technician notes"}</span>
                      <ChevronRight
                        className={cn(
                          "w-3 h-3 transition-transform duration-150",
                          isExpanded && "rotate-90"
                        )}
                        aria-hidden="true"
                      />
                    </button>

                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="mt-2 p-2.5 rounded-lg bg-[#fafafa] border border-[#e7e7e7] text-[11px] text-[#4e505b] leading-relaxed">
                            {appt.notes}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
