import { auth } from "@/auth";
export default auth((req) => {
  if (!req.auth && !req.nextUrl.pathname.startsWith("/api/") && req.nextUrl.pathname !== "/login") {
    return Response.redirect(new URL("/login", req.nextUrl));
  }
});
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };