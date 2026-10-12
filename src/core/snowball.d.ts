declare module "snowball" {
  const snowball: { newStemmer(langue: string): { stem(mot: string): string } };
  export default snowball;
}
