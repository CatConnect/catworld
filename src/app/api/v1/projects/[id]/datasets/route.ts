import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { createDataset } from "@/server/data/catalog";
import { handleApiError, ok } from "@/server/http";
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{await resolveActor(request);return ok(await prisma.dataset.findMany({where:{projectId:(await params).id,active:true},include:{tables:true},orderBy:{name:"asc"}}));}catch(e){return handleApiError(e)}}
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{const actor=await resolveActor(request);requireRole(actor,["ADMIN","DATA_MANAGER"]);const input=z.object({name:z.string().min(2).max(255),description:z.string().max(1000).optional()}).parse(await request.json());return ok(await createDataset((await params).id,input),undefined,201);}catch(e){return handleApiError(e)}}