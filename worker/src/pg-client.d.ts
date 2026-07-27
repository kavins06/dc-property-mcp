declare module "pg/lib/client.js" {
  const Client: typeof import("pg").Client;
  export default Client;
}
