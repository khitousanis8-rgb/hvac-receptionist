"use client";

import * as React from "react";
import {
  add,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  getDay,
  isEqual,
  isSameDay,
  isSameMonth,
  isToday,
  parse,
  startOfToday,
  startOfWeek,
} from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  Clock,
  User,
  Phone,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";

export interface Event {
  id: number | string;
  name: string;
  time: string;
  datetime: string;
  customerName?: string | null;
  customerPhone?: string;
  status?: string;
  notes?: string | null;
}

export interface CalendarData {
  day: Date;
  events: Event[];
}

export interface FullScreenCalendarProps {
  data: CalendarData[];
  onSelectDay?: (day: Date) => void;
  selectedDay?: Date;
  onEventClick?: (event: Event) => void;
}

const colStartClasses = [
  "",
  "col-start-2",
  "col-start-3",
  "col-start-4",
  "col-start-5",
  "col-start-6",
  "col-start-7",
];

export function FullScreenCalendar({
  data,
  onSelectDay,
  selectedDay: controlledSelectedDay,
  onEventClick,
}: FullScreenCalendarProps) {
  const today = startOfToday();
  const [internalSelectedDay, setInternalSelectedDay] = React.useState<Date>(today);
  const selectedDay = controlledSelectedDay ?? internalSelectedDay;

  const [currentMonth, setCurrentMonth] = React.useState(format(today, "MMM-yyyy"));
  const firstDayCurrentMonth = parse(currentMonth, "MMM-yyyy", new Date());
  const isDesktop = useMediaQuery("(min-width: 768px)");

  const days = React.useMemo(() => {
    return eachDayOfInterval({
      start: startOfWeek(firstDayCurrentMonth),
      end: endOfWeek(endOfMonth(firstDayCurrentMonth)),
    });
  }, [firstDayCurrentMonth]);

  function handleSelectDay(day: Date) {
    setInternalSelectedDay(day);
    onSelectDay?.(day);
  }

  function previousMonth() {
    const firstDayPrevMonth = add(firstDayCurrentMonth, { months: -1 });
    setCurrentMonth(format(firstDayPrevMonth, "MMM-yyyy"));
  }

  function nextMonth() {
    const firstDayNextMonth = add(firstDayCurrentMonth, { months: 1 });
    setCurrentMonth(format(firstDayNextMonth, "MMM-yyyy"));
  }

  function goToToday() {
    setCurrentMonth(format(today, "MMM-yyyy"));
    handleSelectDay(today);
  }

  // Find events for the selected day
  const selectedDayEvents = React.useMemo(() => {
    const found = data.find((d) => isSameDay(d.day, selectedDay));
    return found ? found.events : [];
  }, [data, selectedDay]);

  return (
    <div className="flex flex-col space-y-4 font-sans">
      {/* Outer Card */}
      <div className="rounded-lg border border-[#e7e7e7] bg-white overflow-hidden shadow-xs">
        {/* Calendar Header Bar */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 p-4 border-b border-[#e7e7e7] bg-white">
          <div className="flex items-center gap-3.5">
            {/* Mini Today Box */}
            <div className="hidden sm:flex flex-col items-center justify-center w-14 rounded-md border border-[#e7e7e7] bg-[#fafafa] p-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#4e505b]">
                {format(today, "MMM")}
              </span>
              <div className="flex items-center justify-center w-full rounded border border-[#e7e7e7] bg-white text-[15px] font-semibold text-[#0a0a0a] leading-none py-1 mt-0.5">
                {format(today, "d")}
              </div>
            </div>

            <div className="space-y-0.5">
              <h2 className="text-[16px] md:text-[18px] font-semibold text-[#0a0a0a] leading-tight">
                {format(firstDayCurrentMonth, "MMMM yyyy")}
              </h2>
              <p className="text-[11px] font-mono text-[#4e505b]">
                {format(firstDayCurrentMonth, "MMM d")} – {format(endOfMonth(firstDayCurrentMonth), "MMM d, yyyy")}
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            <div className="inline-flex -space-x-px rounded-md shadow-xs">
              <button
                type="button"
                onClick={previousMonth}
                aria-label="Previous month"
                className="inline-flex items-center justify-center p-1.5 rounded-l-md border border-[#e7e7e7] bg-white hover:bg-[#fafafa] text-[#0a0a0a] transition-colors duration-150 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4 text-[#4e505b]" />
              </button>
              <button
                type="button"
                onClick={goToToday}
                className="inline-flex items-center justify-center px-3 py-1.5 text-[12px] font-medium border border-[#e7e7e7] bg-white hover:bg-[#fafafa] text-[#0a0a0a] transition-colors duration-150 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer"
              >
                Today
              </button>
              <button
                type="button"
                onClick={nextMonth}
                aria-label="Next month"
                className="inline-flex items-center justify-center p-1.5 rounded-r-md border border-[#e7e7e7] bg-white hover:bg-[#fafafa] text-[#0a0a0a] transition-colors duration-150 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer"
              >
                <ChevronRight className="w-4 h-4 text-[#4e505b]" />
              </button>
            </div>
          </div>
        </div>

        {/* Days of the Week Header */}
        <div className="grid grid-cols-7 border-b border-[#e7e7e7] bg-[#fafafa] text-center text-[11px] font-mono font-semibold uppercase tracking-wider text-[#4e505b]">
          <div className="py-2.5 border-r border-[#e7e7e7]">Sun</div>
          <div className="py-2.5 border-r border-[#e7e7e7]">Mon</div>
          <div className="py-2.5 border-r border-[#e7e7e7]">Tue</div>
          <div className="py-2.5 border-r border-[#e7e7e7]">Wed</div>
          <div className="py-2.5 border-r border-[#e7e7e7]">Thu</div>
          <div className="py-2.5 border-r border-[#e7e7e7]">Fri</div>
          <div className="py-2.5">Sat</div>
        </div>

        {/* Desktop Calendar Grid */}
        <div className="hidden md:grid grid-cols-7 bg-white">
          {days.map((day, dayIdx) => {
            const isSelected = isEqual(day, selectedDay);
            const isCurrentMonth = isSameMonth(day, firstDayCurrentMonth);
            const isTodayDay = isToday(day);
            const dayEvents = data.find((d) => isSameDay(d.day, day))?.events || [];

            return (
              <div
                key={day.toISOString()}
                onClick={() => handleSelectDay(day)}
                className={cn(
                  dayIdx === 0 && colStartClasses[getDay(day)],
                  "min-h-[110px] p-2 border-b border-r border-[#e7e7e7] transition-colors duration-150 cursor-pointer flex flex-col justify-between",
                  !isCurrentMonth && "bg-[#fafafa]/50",
                  isSelected && "bg-[#f4f4f5]/60 ring-1 ring-inset ring-[#0a0a0a]",
                  !isSelected && "hover:bg-[#fafafa]"
                )}
              >
                {/* Cell Header with Date */}
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      "flex items-center justify-center w-6 h-6 rounded-full text-[12px] font-mono font-semibold transition-colors duration-150",
                      isTodayDay
                        ? "bg-[#0b5ed7] text-[#ffffff]"
                        : isSelected
                        ? "bg-[#0a0a0a] text-[#ffffff]"
                        : isCurrentMonth
                        ? "text-[#0a0a0a]"
                        : "text-[#a1a1aa]"
                    )}
                  >
                    {format(day, "d")}
                  </span>

                  {dayEvents.length > 0 && (
                    <span className="text-[10px] font-mono text-[#0b5ed7] font-semibold bg-[#eff6ff] border border-[#bfdbfe] px-1.5 py-0.5 rounded-full">
                      {dayEvents.length} {dayEvents.length === 1 ? "appt" : "appts"}
                    </span>
                  )}
                </div>

                {/* Event Snippets */}
                <div className="mt-2 space-y-1 flex-1">
                  {dayEvents.slice(0, 2).map((event) => (
                    <div
                      key={event.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelectDay(day);
                        onEventClick?.(event);
                      }}
                      className="rounded border border-[#e7e7e7] bg-[#fafafa] hover:bg-white hover:border-[#0b5ed7] p-1.5 transition-colors duration-150 cursor-pointer shadow-2xs"
                      title={`${event.name} (${event.time})`}
                    >
                      <div className="text-[11px] font-medium text-[#0a0a0a] truncate leading-tight">
                        {event.name}
                      </div>
                      <div className="text-[10px] font-mono text-[#4e505b] leading-tight mt-0.5">
                        {event.time}
                      </div>
                    </div>
                  ))}

                  {dayEvents.length > 2 && (
                    <div className="text-[10px] font-mono font-semibold text-[#0b5ed7] px-1 hover:underline">
                      + {dayEvents.length - 2} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Mobile Calendar Grid */}
        <div className="grid grid-cols-7 md:hidden bg-white">
          {days.map((day) => {
            const isSelected = isEqual(day, selectedDay);
            const isCurrentMonth = isSameMonth(day, firstDayCurrentMonth);
            const isTodayDay = isToday(day);
            const dayEvents = data.find((d) => isSameDay(d.day, day))?.events || [];

            return (
              <button
                key={day.toISOString()}
                type="button"
                onClick={() => handleSelectDay(day)}
                className={cn(
                  "h-16 p-1 border-b border-r border-[#e7e7e7] flex flex-col items-center justify-between transition-colors duration-150",
                  !isCurrentMonth && "bg-[#fafafa]/50 opacity-40",
                  isSelected && "bg-[#f4f4f5] ring-1 ring-inset ring-[#0a0a0a]",
                  !isSelected && "hover:bg-[#fafafa]"
                )}
              >
                <span
                  className={cn(
                    "flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-mono font-semibold",
                    isTodayDay
                      ? "bg-[#0b5ed7] text-[#ffffff]"
                      : isSelected
                      ? "bg-[#0a0a0a] text-[#ffffff]"
                      : "text-[#0a0a0a]"
                  )}
                >
                  {format(day, "d")}
                </span>

                {dayEvents.length > 0 && (
                  <div className="flex gap-0.5 mt-auto pb-1">
                    {dayEvents.slice(0, 3).map((_, i) => (
                      <span
                        key={i}
                        className="w-1.5 h-1.5 rounded-full bg-[#0b5ed7]"
                      />
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected Day Details Panel */}
      <div className="rounded-lg border border-[#e7e7e7] bg-white overflow-hidden shadow-xs">
        <div className="px-4 py-2.5 border-b border-[#e7e7e7] bg-[#fafafa] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarIcon className="w-4 h-4 text-[#4e505b]" />
            <h3 className="text-[12px] font-semibold text-[#0a0a0a]">
              Appointments for {format(selectedDay, "EEEE, MMMM d, yyyy")}
            </h3>
          </div>
          <span className="text-[11px] font-mono text-[#4e505b]">
            {selectedDayEvents.length} {selectedDayEvents.length === 1 ? "booking" : "bookings"}
          </span>
        </div>

        {selectedDayEvents.length === 0 ? (
          <div className="p-8 text-center text-[12px] text-[#4e505b]">
            No appointments scheduled for this date.
          </div>
        ) : (
          <div className="divide-y divide-[#e7e7e7]">
            {selectedDayEvents.map((evt) => (
              <div
                key={evt.id}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[#fafafa] transition-colors duration-150"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-[#0a0a0a]">
                      {evt.name}
                    </span>
                    {evt.status && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wider border border-[#a7f3d0] bg-[#ecfdf5] text-[#059669]">
                        {evt.status}
                      </span>
                    )}
                  </div>
                  {evt.notes && (
                    <p className="text-[11px] text-[#4e505b] max-w-xl">
                      {evt.notes}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-[#4e505b]">
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" />
                    <span>{evt.time}</span>
                  </div>
                  {evt.customerName && (
                    <div className="flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5" />
                      <span className="font-sans text-[#0a0a0a] font-medium">{evt.customerName}</span>
                    </div>
                  )}
                  {evt.customerPhone && (
                    <div className="flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5" />
                      <span>{evt.customerPhone}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
