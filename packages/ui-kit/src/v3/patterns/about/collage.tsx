// About «collage»: the story on the left; on the right two or three photos of the place in different formats — a tall
// one as high as the others stepped down beside it — so the section shows the place rather than describes it. On
// phones the collage follows the text at a smaller scale. Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type AboutCollageProps = {
  title: string;
  lead?: string;
  paragraphs: string[];
  images: Image[];
  action?: Link;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const photoClass = "w-full rounded-md bg-muted object-cover";

export default function AboutCollage({ title, lead, paragraphs, images, action }: AboutCollageProps) {
  const [first, second, third] = images;
  return (
    <section className="overflow-hidden bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page items-center gap-12 px-gutter py-section lg:grid-cols-12 lg:gap-x-12">
        <div className="min-w-0 lg:col-span-5">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-5 text-lead text-pretty">{lead}</p> : null}
          <div className="mt-5 grid gap-4 text-body text-pretty text-muted-foreground">
            {paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          {action ? (
            <a href={action.href} className={`mt-8 ${primaryClass}`}>
              {action.label}
            </a>
          ) : null}
        </div>
        <div className="grid min-w-0 grid-cols-12 gap-3 sm:gap-4 lg:col-span-7">
          {first ? (
            <img
              src={first.src}
              srcSet={srcSetOf(first.src)}
              sizes="(min-width: 1024px) 50vw, 100vw"
              alt={first.alt}
              loading="lazy"
              className={`col-span-7 row-span-2 ${third ? "h-full" : "aspect-3/4 self-start"} ${photoClass}`}
            />
          ) : null}
          {second ? (
            <img
              src={second.src}
              srcSet={srcSetOf(second.src)}
              sizes="(min-width: 1024px) 50vw, 100vw"
              alt={second.alt}
              loading="lazy"
              className={`col-span-5 mt-10 aspect-square self-start sm:mt-16 ${photoClass}`}
            />
          ) : null}
          {third ? (
            <img
              src={third.src}
              srcSet={srcSetOf(third.src)}
              sizes="(min-width: 1024px) 50vw, 100vw"
              alt={third.alt}
              loading="lazy"
              className={`col-span-5 aspect-4/5 self-start ${photoClass}`}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
