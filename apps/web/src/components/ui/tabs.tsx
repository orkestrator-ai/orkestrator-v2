import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";
import { SEGMENT_TRACK_CLASS_NAME } from "./segmented-selector";

const listStyles = {
  underline: "gap-2",
  pill: "gap-1",
  segmented: SEGMENT_TRACK_CLASS_NAME,
};

type TabsVariant = keyof typeof listStyles;

const triggerStyles: Record<TabsVariant, string> = {
  underline:
    "border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground",
  pill: "rounded-full data-[state=active]:bg-primary-fill data-[state=active]:text-primary-foreground data-[state=active]:[--focus-hairline-color:currentColor]",
  segmented:
    "rounded-md font-normal data-[state=active]:bg-primary-fill data-[state=active]:font-bold data-[state=active]:text-primary-foreground data-[state=active]:[--focus-hairline-color:currentColor]",
};

const TabsListVariant = React.createContext<TabsVariant>("segmented");

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function TabsList({
  variant,
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & { variant: TabsVariant }) {
  return (
    <TabsListVariant.Provider value={variant}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        className={cn("inline-flex w-fit min-w-0 items-center", listStyles[variant], className)}
        {...props}
      />
    </TabsListVariant.Provider>
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = React.useContext(TabsListVariant);
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "focus-hairline text-muted-foreground hover:text-foreground inline-flex h-8 flex-1 items-center justify-center gap-1.5 px-3 text-sm font-medium whitespace-nowrap transition-[background-color,color,border-color] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        triggerStyles[variant],
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
