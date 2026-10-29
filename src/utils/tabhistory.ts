// Back and Forward for one tab. The tab's page keeps its own history, but it is shared with every
// other frame on the page (all tabs, and Persec itself), so it can't be used per tab. This list
// records where the tab's page actually is: addresses Persec opened and links clicked inside a
// site alike. Every address is absolute.
export class TabHistory {
  stack: string[] = [];
  idx = -1;
  // Set while a page Persec asked for is loading: `from` is where the tab was, so a look at the
  // tab before the new page arrives isn't taken for a navigation.
  private pending: { from: string } | null = null;

  get current(): string | undefined {
    return this.stack[this.idx];
  }

  private push(url: string) {
    if (this.current === url) return;
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push(url);
    this.idx = this.stack.length - 1;
  }

  // Persec opens `url` in the tab, which is now at `from`.
  open(url: string, from: string) {
    this.push(url);
    this.pending = { from };
  }

  // The address to go back (or forward) to, or undefined at the end of the list.
  back(from: string): string | undefined {
    if (this.idx <= 0) return undefined;
    this.idx--;
    this.pending = { from };
    return this.current;
  }

  forward(from: string): string | undefined {
    if (this.idx >= this.stack.length - 1) return undefined;
    this.idx++;
    this.pending = { from };
    return this.current;
  }

  // The tab's page is now at `href`.
  landed(href: string) {
    if (!href || href === 'about:blank') return;
    if (this.pending) {
      if (href === this.pending.from) return;
      this.pending = null;
      // Where a page Persec opened ended up (a redirect) takes that page's place.
      if (this.idx >= 0) this.stack[this.idx] = href;
      else this.push(href);
      return;
    }
    // A link or a script inside the page.
    this.push(href);
  }
}
