/**
 * Searchable picker for code blocks: a query input over a windowed result list.
 *
 * Modelled on pi's own /thinking selector — same Input + fuzzyFilter + SelectList
 * combination — and self-contained: everything comes from the pi and pi-tui
 * public exports, so no internal path is borrowed and the built-in selectors do
 * not have to change.
 *
 * The query matches language + the whole block text (fuzzy, so query characters
 * may be skipped). On a 2000-block session a keystroke costs a few milliseconds.
 *
 * Row values are the frozen ordinal, so filtering never renumbers rows and the
 * copied block is always the one the label names.
 */
import {
  DynamicBorder,
  getSelectListTheme,
  keyHint,
  rawKeyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  type Focusable,
  getKeybindings,
  Input,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import {
  candidateOfValue,
  matchCandidates,
  pickerItems,
  searchTextOf,
  type Candidate,
  type PickerItem,
} from "./candidates.ts";

/** Rows rendered at once; SelectList scrolls and shows "(n/total)" beyond this. */
const MAX_VISIBLE = 10;

const LAYOUT = { minPrimaryColumnWidth: 30, maxPrimaryColumnWidth: 56 };

export class CodePicker extends Container implements Focusable {
  private readonly candidates: readonly Candidate[];
  private readonly done: (chosen: Candidate | undefined) => void;
  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private list: SelectList;
  private focusedState = false;

  constructor(candidates: readonly Candidate[], theme: Theme, done: (chosen: Candidate | undefined) => void) {
    super();
    this.candidates = candidates;
    this.done = done;

    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        theme.fg("accent", theme.bold(`Copy which code block? (${candidates.length}, newest first)`)),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    // Enter in the search field takes the highlighted row.
    this.searchInput.onSubmit = () => this.list.handleInput("\r");
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        rawKeyHint("↑↓", "navigate") +
          "  " +
          rawKeyHint("type", "to search") +
          "  " +
          keyHint("tui.select.confirm", "copy") +
          "  " +
          keyHint("tui.select.cancel", "cancel"),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());

    this.list = this.buildList(pickerItems(candidates));
    this.listContainer.addChild(this.list);
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.searchInput.focused = value;
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    const isNavigation =
      kb.matches(keyData, "tui.select.up") ||
      kb.matches(keyData, "tui.select.down") ||
      kb.matches(keyData, "tui.select.confirm") ||
      kb.matches(keyData, "tui.select.cancel");
    if (isNavigation) {
      this.list.handleInput(keyData);
      return;
    }
    this.searchInput.handleInput(keyData);
    this.applyFilter(this.searchInput.getValue());
  }

  private buildList(items: readonly PickerItem[]): SelectList {
    const list = new SelectList([...items], MAX_VISIBLE, getSelectListTheme(), LAYOUT);
    list.onSelect = (item) => this.done(candidateOfValue(this.candidates, item.value));
    list.onCancel = () => this.done(undefined);
    return list;
  }

  private applyFilter(query: string): void {
    // Digits are an exact id lookup instead of a fuzzy scan, so typing the id you see in
    // the gutter finds exactly that block.
    const matched = matchCandidates(this.candidates, query, (text) =>
      fuzzyFilter([...this.candidates], text, searchTextOf),
    );
    this.list = this.buildList(pickerItems(matched));
    this.listContainer.clear();
    this.listContainer.addChild(this.list);
    this.searchInput.focused = this.focusedState;
  }
}
