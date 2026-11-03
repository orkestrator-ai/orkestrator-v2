import Link from "next/link";

export default async function Item({ params }) {
  const { id } = await params;
  return (
    <main>
      <h1 id="item">Item {id}</h1>
      <Link id="home-link" href="/">
        Home
      </Link>
    </main>
  );
}
