import type { DesignStyleProperty } from "./DesignStyleField";

export interface InspectorSection {
  title: string;
  properties: DesignStyleProperty[];
}

export const inspectorSections: InspectorSection[] = [
  {
    title: "Layout",
    properties: [
      {
        name: "display",
        label: "Display",
        options: [
          "block",
          "inline",
          "inline-block",
          "flex",
          "inline-flex",
          "grid",
          "inline-grid",
          "contents",
          "none",
        ],
        wide: true,
      },
      {
        name: "flex-direction",
        label: "Direction",
        options: ["row", "column", "row-reverse", "column-reverse"],
      },
      { name: "flex-wrap", label: "Wrap", options: ["nowrap", "wrap", "wrap-reverse"] },
      {
        name: "align-items",
        label: "Align items",
        options: [
          "normal",
          "stretch",
          "flex-start",
          "center",
          "flex-end",
          "start",
          "end",
          "baseline",
        ],
        wide: true,
      },
      {
        name: "justify-content",
        label: "Justify content",
        options: [
          "normal",
          "flex-start",
          "center",
          "flex-end",
          "start",
          "end",
          "space-between",
          "space-around",
          "space-evenly",
          "stretch",
        ],
        wide: true,
      },
      {
        name: "position",
        label: "Position",
        options: ["static", "relative", "absolute", "fixed", "sticky"],
        wide: true,
      },
      { name: "top", label: "Top" },
      { name: "left", label: "Left" },
      { name: "bottom", label: "Bottom" },
      { name: "right", label: "Right" },
    ],
  },
  {
    title: "Size and spacing",
    properties: [
      { name: "width", label: "Width" },
      { name: "height", label: "Height" },
      { name: "min-width", label: "Min width" },
      { name: "min-height", label: "Min height" },
      { name: "max-width", label: "Max width" },
      { name: "max-height", label: "Max height" },
      {
        name: "box-sizing",
        label: "Box sizing",
        options: ["border-box", "content-box"],
        wide: true,
      },
      { name: "padding", label: "Padding" },
      { name: "margin", label: "Margin" },
      { name: "gap", label: "Gap", wide: true },
    ],
  },
  {
    title: "Typography",
    properties: [
      { name: "font-size", label: "Size" },
      {
        name: "font-weight",
        label: "Weight",
        options: [
          "100",
          "200",
          "300",
          "400",
          "500",
          "600",
          "700",
          "800",
          "900",
          "normal",
          "bold",
          "lighter",
          "bolder",
        ],
      },
      { name: "font-family", label: "Font family", wide: true },
      { name: "line-height", label: "Line height" },
      { name: "letter-spacing", label: "Letter spacing" },
      {
        name: "text-align",
        label: "Align",
        options: ["start", "end", "left", "center", "right", "justify"],
        wide: true,
      },
      { name: "color", label: "Color", color: true, wide: true },
    ],
  },
  {
    title: "Appearance",
    properties: [
      { name: "background-color", label: "Fill", color: true, wide: true },
      { name: "border-color", label: "Border color", color: true, wide: true },
      { name: "border-width", label: "Border width" },
      {
        name: "border-style",
        label: "Border style",
        options: [
          "none",
          "solid",
          "dashed",
          "dotted",
          "double",
          "groove",
          "ridge",
          "inset",
          "outset",
        ],
      },
      { name: "border-radius", label: "Radius" },
      { name: "opacity", label: "Opacity (0–1)" },
      {
        name: "visibility",
        label: "Visibility",
        options: ["visible", "hidden", "collapse"],
        wide: true,
      },
    ],
  },
];

export const groupedPropertyNames: ReadonlySet<string> = new Set(
  inspectorSections.flatMap((section) => section.properties.map((property) => property.name)),
);
