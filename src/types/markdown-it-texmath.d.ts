declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";
  import type { KatexOptions } from "katex";

  interface TexmathOptions {
    engine: {
      renderToString(tex: string, options?: KatexOptions): string;
    };
    /** "dollars" | "brackets" | "gitlab" | "doxygen" | ... or array of them */
    delimiters?: string | string[];
    katexOptions?: KatexOptions;
  }

  const texmath: {
    (md: MarkdownIt, options: TexmathOptions): void;
    use(md: MarkdownIt, options: TexmathOptions): void;
  };
  export default texmath;
}
