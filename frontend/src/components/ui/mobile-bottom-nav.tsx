"use client";

import React from "react";
import {
  LayoutDashboard,
  PhoneCall,
  CalendarCheck,
  Settings,
  Radio,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export type Page = "dashboard" | "live-call" | "calls" | "appointments" | "settings";

interface MobileBottomNavProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  callCount?: number;
  appointmentCount?: number;
  isInCall?: boolean;
}

export function MobileBottomNav({
  currentPage,
  onNavigate,
  callCount = 0,
  appointmentCount = 0,
  isInCall = false,
}: MobileBottomNavProps) {
  const navItems = [
    {
      page: "dashboard" as Page,
      label: "Overview",
      icon: LayoutDashboard,
      badge: null,
    },
    {
      page: "calls" as Page,
      label: "Calls",
      icon: PhoneCall,
      badge: callCount > 0 ? callCount : null,
    },
    {
      page: "live-call" as Page,
      label: "Live Call",
      icon: Radio,
      isCenter: true,
      badge: isInCall ? "LIVE" : null,
    },
    {
      page: "appointments" as Page,
      label: "Schedule",
      icon: CalendarCheck,
      badge: appointmentCount > 0 ? appointmentCount : null,
    },
    {
      page: "settings" as Page,
      label: "Settings",
      icon: Settings,
      badge: null,
    },
  ];

  return (
    <nav
      aria-label="Mobile Navigation"
      className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-white/95 backdrop-blur-md border-t border-[#e7e7e7] pb-safe shadow-[0_-4px_16px_rgba(0,0,0,0.03)]"
    >
      <div className="grid grid-cols-5 items-center h-16 max-w-lg mx-auto px-2">
        {navItems.map((item) => {
          const isActive = currentPage === item.page;
          const Icon = item.icon;

          if (item.isCenter) {
            return (
              <div key={item.page} className="flex justify-center -mt-4 relative">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  onClick={() => onNavigate(item.page)}
                  aria-label="Live Voice Call Console"
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "relative flex flex-col items-center justify-center w-14 h-14 rounded-full shadow-md transition-all duration-200 cursor-pointer",
                    isActive || isInCall
                      ? "bg-[#0b5ed7] text-white shadow-[#0b5ed7]/25 ring-4 ring-[#eff6ff]"
                      : "bg-[#0a0a0a] text-white hover:bg-[#242424] shadow-black/15"
                  )}
                >
                  {/* Subtle pulsing wave when in call or active */}
                  {(isInCall || isActive) && (
                    <motion.span
                      initial={{ scale: 1, opacity: 0.6 }}
                      animate={{ scale: [1, 1.35, 1], opacity: [0.6, 0, 0.6] }}
                      transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                      className="absolute inset-0 rounded-full border-2 border-[#0b5ed7] pointer-events-none"
                    />
                  )}
                  <Icon className="w-6 h-6 shrink-0" aria-hidden="true" />
                  <span className="text-[9px] font-semibold tracking-tight mt-0.5 leading-none">
                    {isInCall ? "LIVE" : "CALL"}
                  </span>
                </motion.button>
              </div>
            );
          }

          return (
            <motion.button
              key={item.page}
              type="button"
              whileTap={{ scale: 0.92 }}
              onClick={() => onNavigate(item.page)}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative flex flex-col items-center justify-center h-full py-1 text-center transition-colors duration-150 cursor-pointer select-none",
                isActive ? "text-[#0b5ed7]" : "text-[#71717a] hover:text-[#0a0a0a]"
              )}
            >
              <div className="relative">
                <Icon
                  className={cn(
                    "w-5 h-5 transition-transform duration-150",
                    isActive && "scale-110"
                  )}
                  aria-hidden="true"
                />
                {item.badge !== null && (
                  <span
                    className={cn(
                      "absolute -top-1.5 -right-2 px-1 py-0.2 min-w-[14px] text-[9px] font-mono tabular-nums font-semibold rounded-full border leading-tight flex items-center justify-center",
                      isActive
                        ? "bg-[#0b5ed7] text-white border-white"
                        : "bg-[#f4f4f5] text-[#0a0a0a] border-[#e7e7e7]"
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </div>

              <span
                className={cn(
                  "text-[10px] tracking-tight mt-1 transition-all duration-150 font-medium",
                  isActive ? "font-semibold text-[#0a0a0a]" : "text-[#71717a]"
                )}
              >
                {item.label}
              </span>

              {/* Active Pill Indicator */}
              {isActive && (
                <motion.div
                  layoutId="mobileNavIndicator"
                  className="absolute bottom-1 w-4 h-0.5 rounded-full bg-[#0b5ed7]"
                  transition={{ type: "spring", stiffness: 350, damping: 30 }}
                />
              )}
            </motion.button>
          );
        })}
      </div>
    </nav>
  );
}
