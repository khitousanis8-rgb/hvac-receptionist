"use client";

import { cn } from "@/lib/utils";
import React, { useState, createContext, useContext } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";

interface Links {
  label: string;
  href: string;
  icon: React.JSX.Element | React.ReactNode;
  onClick?: () => void;
}

interface SidebarContextProps {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  animate: boolean;
}

const SidebarContext = createContext<SidebarContextProps | undefined>(
  undefined
);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
};

export const SidebarProvider = ({
  children,
  open: openProp,
  setOpen: setOpenProp,
  animate = true,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) => {
  const [openState, setOpenState] = useState(false);

  const open = openProp !== undefined ? openProp : openState;
  const setOpen = setOpenProp !== undefined ? setOpenProp : setOpenState;

  return (
    <SidebarContext.Provider value={{ open, setOpen, animate }}>
      {children}
    </SidebarContext.Provider>
  );
};

export const Sidebar = ({
  children,
  open,
  setOpen,
  animate,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) => {
  return (
    <SidebarProvider open={open} setOpen={setOpen} animate={animate}>
      {children}
    </SidebarProvider>
  );
};

export const SidebarBody = (props: React.ComponentProps<typeof motion.div>) => {
  return (
    <>
      <DesktopSidebar {...props} />
      <MobileSidebar {...(props as React.ComponentProps<"div">)} />
    </>
  );
};

export const DesktopSidebar = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof motion.div>) => {
  const { open, setOpen, animate } = useSidebar();
  return (
    <motion.div
      className={cn(
        "h-full px-3 py-4 hidden md:flex md:flex-col bg-white border-r border-[#e7e7e7] w-[260px] flex-shrink-0",
        className
      )}
      animate={{
        width: animate ? (open ? "260px" : "60px") : "260px",
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      {...props}
    >
      {children}
    </motion.div>
  );
};

export const MobileSidebar = ({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) => {
  const { open, setOpen } = useSidebar();
  return (
    <>
      <div
        className={cn(
          "h-14 px-4 flex flex-row md:hidden items-center justify-between bg-white border-b border-[#e7e7e7] w-full flex-shrink-0 z-30"
        )}
        {...props}
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[13px] tracking-tight text-[#0a0a0a]">
            HVAC Receptionist
          </span>
        </div>
        <button
          type="button"
          aria-label="Toggle navigation menu"
          className="p-2 rounded-md hover:bg-[#f4f4f5] text-[#0a0a0a] transition-colors duration-150 cursor-pointer"
          onClick={() => setOpen(!open)}
        >
          <Menu className="w-5 h-5 text-[#0a0a0a]" />
        </button>

        <AnimatePresence>
          {open && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onClick={() => setOpen(false)}
                className="fixed inset-0 bg-black/30 backdrop-blur-xs z-[90]"
              />

              <motion.div
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={{
                  type: "spring",
                  damping: 28,
                  stiffness: 280,
                }}
                className={cn(
                  "fixed inset-y-0 left-0 w-72 max-w-[85vw] bg-white border-r border-[#e7e7e7] p-5 z-[100] flex flex-col justify-between shadow-2xl overflow-y-auto",
                  className
                )}
              >
                <div
                  className="absolute right-4 top-4 p-1.5 rounded-md hover:bg-[#f4f4f5] text-[#4e505b] hover:text-[#0a0a0a] cursor-pointer transition-colors"
                  onClick={() => setOpen(false)}
                >
                  <X className="w-5 h-5" />
                </div>
                <div className="flex-1 flex flex-col mt-2">
                  {children}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </>
  );
};

export const SidebarLink = ({
  link,
  className,
  ...props
}: {
  link: Links;
  className?: string;
  props?: React.ComponentProps<"a">;
}) => {
  const { open, animate } = useSidebar();
  return (
    <a
      href={link.href}
      onClick={(e) => {
        e.preventDefault();
        link.onClick?.();
      }}
      className={cn(
        "flex items-center justify-start gap-2 py-2 cursor-pointer text-[12px] font-medium transition-colors duration-150",
        className
      )}
      {...props}
    >
      {link.icon}
      <motion.span
        animate={{
          display: animate ? (open ? "inline-block" : "none") : "inline-block",
          opacity: animate ? (open ? 1 : 0) : 1,
        }}
        transition={{ duration: 0.1 }}
        className="text-[#0a0a0a] text-[12px] whitespace-pre inline-block !p-0 !m-0"
      >
        {link.label}
      </motion.span>
    </a>
  );
};