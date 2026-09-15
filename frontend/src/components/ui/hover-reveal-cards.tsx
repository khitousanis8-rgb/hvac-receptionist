import React from "react";
import { cn } from "@/lib/utils";

/**
 * @typedef CardItem
 * @property {string | number} id - Unique identifier for the card.
 * @property {string} title - The main title text of the card.
 * @property {string} subtitle - The subtitle or category text.
 * @property {string} imageUrl - The URL for the card's background image.
 * @property {string} [badge] - Optional badge or tag label.
 * @property {string} [description] - Optional secondary description.
 */
export interface CardItem {
  id: string | number;
  title: string;
  subtitle: string;
  imageUrl: string;
  badge?: string;
  description?: string;
}

/**
 * @typedef HoverRevealCardsProps
 * @property {CardItem[]} items - An array of card item objects to display.
 * @property {string} [className] - Optional additional class names for the container.
 * @property {string} [cardClassName] - Optional additional class names for individual cards.
 * @property {(item: CardItem) => void} [onCardClick] - Optional callback when a card is clicked or activated.
 */
export interface HoverRevealCardsProps {
  items: CardItem[];
  className?: string;
  cardClassName?: string;
  onCardClick?: (item: CardItem) => void;
}

/**
 * A component that displays a grid of cards with a hover-reveal effect.
 * On PC (pointer/hover devices), when a card is hovered or focused, it stands out while others are de-emphasized.
 * On mobile/phones, touch interactions remain smooth, responsive, and avoid sticky blur states.
 */
export const HoverRevealCards: React.FC<HoverRevealCardsProps> = ({
  items,
  className,
  cardClassName,
  onCardClick,
}) => {
  return (
    // The `group` class on the container enables styling children on parent hover.
    <div
      role="list"
      className={cn(
        "hover-reveal-group group grid w-full grid-cols-1 gap-4 p-1 sm:grid-cols-2 lg:grid-cols-4",
        className
      )}
    >
      {items.map((item) => (
        <div
          key={item.id}
          role="listitem"
          aria-label={`${item.title}, ${item.subtitle}`}
          tabIndex={0}
          onClick={() => onCardClick?.(item)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onCardClick?.(item);
            }
          }}
          className={cn(
            "hover-reveal-card relative h-72 sm:h-80 cursor-pointer overflow-hidden rounded-2xl bg-cover bg-center shadow-md transition-all duration-500 ease-in-out select-none border border-white/10",
            // Mobile active tap feedback
            "active:scale-[0.98] transition-transform",
            // Accessibility focus ring
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] focus-visible:ring-offset-2",
            cardClassName
          )}
          style={{ backgroundImage: `url(${item.imageUrl})` }}
        >
          {/* Gradient overlay for high contrast text readability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/45 to-black/10 transition-opacity duration-300" />

          {/* Top Badge (if present) */}
          {item.badge && (
            <div className="absolute top-3.5 left-3.5 z-10">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium tracking-wide uppercase bg-black/50 backdrop-blur-md text-white/90 border border-white/20 shadow-xs">
                {item.badge}
              </span>
            </div>
          )}

          {/* Card Content */}
          <div className="absolute bottom-0 left-0 right-0 p-5 text-white z-10 flex flex-col justify-end">
            <p className="text-[11px] font-medium uppercase tracking-widest text-blue-300/90 drop-shadow-sm">
              {item.subtitle}
            </p>
            <h3 className="mt-1 text-[17px] sm:text-[18px] font-semibold tracking-tight text-white drop-shadow-md leading-snug">
              {item.title}
            </h3>
            {item.description && (
              <p className="mt-1 text-[11px] text-zinc-300/90 line-clamp-2 leading-relaxed opacity-90 drop-shadow-xs">
                {item.description}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

export default HoverRevealCards;
