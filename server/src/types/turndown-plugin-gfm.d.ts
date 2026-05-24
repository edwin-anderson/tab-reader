declare module "turndown-plugin-gfm" {
  import TurndownService from "turndown";
  export function gfm(turndown: TurndownService): void;
  export function tables(turndown: TurndownService): void;
  export function strikethrough(turndown: TurndownService): void;
  export function taskListItems(turndown: TurndownService): void;
}
