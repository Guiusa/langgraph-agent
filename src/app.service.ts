import * as z from "zod" ;
import { Tool, tool } from "@langchain/core/tools" ;
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";
import { START, END, StateGraph, MessagesAnnotation } from "@langchain/langgraph" ;
import { HumanMessage, BaseMessage, ToolMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { Injectable } from '@nestjs/common';
import { config } from 'dotenv';
config() ;

import { DataSource } from 'typeorm'

@Injectable()
export class AppService {
  private agent: any ;

  constructor(private dataSource: DataSource) {};

  onModuleInit() {
    // Model definition
    // const llm = new ChatGroq({
    //   model: "llama-3.3-70b-versatile",
    //   temperature: 0,
    //   maxTokens: undefined,
    //   maxRetries: 2,
    // }) ;

    const llm = new ChatOpenAI({
      model: "gpt-4o",
      temperature: 0
    }) ;
    //#########################################################################
    
    // Tools definition
    function rowsToTextTable(rows: any[]): string {
      if (!rows || rows.length === 0) return "No results.";

      const cols = Object.keys(rows[0]);

      // header
      const header = `| ${cols.join(" | ")} |`;
      const sep = `| ${cols.map(() => "---").join(" | ")} |`;

      const body = rows
        .map(r => `| ${cols.map(c => String(r[c] ?? "")).join(" | ")} |`)
        .join("\n");

      return `${header}\n${sep}\n${body}`;
    }

    const describeTable = tool(
      async ({table}: {table: string}) => {
        const query = `
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_name = $1
          ORDER BY ordinal_position
        ` ;

        const rows = await this.dataSource.query(query, [table]);
        return rowsToTextTable(rows);
      },
      {
        name: "describe_table",
        description: `
            Returns detailed columns of given table.
            Don't use it to detail the database as it could be unsafe.
            Use it EVERYTIME you need to run a query, so you know every column available
            Use the RESULTING column names to make queries when needed
          `,
        schema: z.object({
          table: z.string().describe("Name of the table to be described")
        })
      }
    ) ;

    const runQuery = tool(
      async ({query}: {query: string}) => {
        const rows = await this.dataSource.query(query) ;
        return rowsToTextTable(rows) ;
      },
      {
        name: "run_query",
        description: `
          Use this tool to run a query in the database.
          Before using this tool, ALWAYS use the describe_table tool to make sure you know all the columns in the tables  
        `,
        schema: z.object({
          query: z.string().describe("The SQL query to run in the database")
        })
      }
    ) ;

    const toolsByName = {
      [describeTable.name]: describeTable,
      [runQuery.name]: runQuery
    } ;
    //#########################################################################
    
    // Model needs to aknowledge the tools
    const model = llm.bindTools([describeTable, runQuery]) ;

    // Nodes definitions
    const modelNode = async ({ messages }: { messages: BaseMessage[] }) => {
      const response = await model.invoke(
        [
          new SystemMessage(
            `
              You are an agent operating on a store system. 
              Everytime you run a query, you HAVE to make SURE you know the column names. NEVER GUESS, you have a tool to check the EXACT NAMES, DO NOT GUESS
            `
          ),
          ...messages,
        ]
      )
      
      return {
        messages: [...messages, response]
      } ;
    }
    
    const toolNode = async ({ messages }: { messages: BaseMessage[] }) => {
      const last = messages.at(-1) ;

      if(last == null || !AIMessage.isInstance(last)) {
        return { messages } ;
      }

      const result: ToolMessage[] = [] ;

      for (const toolCall of last.tool_calls ?? []) {
        const tool = toolsByName[toolCall.name] ;
        const obs = await (tool as any).invoke(toolCall) ;
        result.push(obs) ;
      }

      return {
        messages: [...messages, ...result] 
      } ;
    }

    const shouldContinue = ({ messages }: { messages: BaseMessage[] }) => {
      const last = messages.at(-1) ;
      if(last == null || !AIMessage.isInstance(last)) return END ;
      
      if(last.tool_calls?.length) return "toolNode" ;

      return END ;
    }
    //#########################################################################
    
    const graph = new StateGraph(MessagesAnnotation) ;     
    this.agent = graph
    .addNode("modelNode", modelNode)
    .addNode("toolNode", toolNode)
    .addEdge(START, "modelNode")
    .addConditionalEdges("modelNode", shouldContinue, ["toolNode", END])
    .addEdge("toolNode", "modelNode")
    .addEdge("modelNode", END)
    .compile() ;

  }


  async getHello(msg: string) {
    return await this.agent.invoke({
      messages: [new HumanMessage(msg)]
    });
  }
}
