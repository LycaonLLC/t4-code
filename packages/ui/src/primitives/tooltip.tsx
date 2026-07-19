// Adapted from T3 Code apps/web/src/components/ui/tooltip.tsx (MIT, T3 Tools
// Inc.). OMP changes: local cn import, token-backed edge shadow.
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "../lib/cn.ts";

const TooltipCreateHandle = TooltipPrimitive.createHandle;

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
	return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipPopup({
	className,
	align = "center",
	sideOffset = 4,
	side = "top",
	anchor,
	collisionPadding,
	collisionAvoidance,
	children,
	...props
}: TooltipPrimitive.Popup.Props & {
	align?: TooltipPrimitive.Positioner.Props["align"];
	side?: TooltipPrimitive.Positioner.Props["side"];
	sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
	anchor?: TooltipPrimitive.Positioner.Props["anchor"];
	collisionPadding?: TooltipPrimitive.Positioner.Props["collisionPadding"];
	collisionAvoidance?: TooltipPrimitive.Positioner.Props["collisionAvoidance"];
}) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Positioner
				align={align}
				anchor={anchor}
				className="pointer-events-none z-50 h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] duration-(--motion-duration-base) ease-(--motion-ease-out) data-instant:transition-none"
				collisionAvoidance={collisionAvoidance}
				collisionPadding={collisionPadding}
				data-slot="tooltip-positioner"
				side={side}
				sideOffset={sideOffset}
			>
				<TooltipPrimitive.Popup
					className={cn(
						"relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md border bg-popover not-dark:bg-clip-padding text-popover-foreground text-xs shadow-md/5 transition-[width,height,scale,opacity] duration-(--motion-duration-fast) ease-(--motion-ease-out) before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-(--surface-edge-shadow) data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0",
						className,
					)}
					data-slot="tooltip-popup"
					{...props}
				>
					<TooltipPrimitive.Viewport
						className="relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"
						data-slot="tooltip-viewport"
					>
						{children}
					</TooltipPrimitive.Viewport>
				</TooltipPrimitive.Popup>
			</TooltipPrimitive.Positioner>
		</TooltipPrimitive.Portal>
	);
}

export { TooltipCreateHandle, TooltipProvider, Tooltip, TooltipTrigger, TooltipPopup };
