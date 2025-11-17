import * as z from "zod" ;
import { tool } from "@langchain/core/tools" ;
import { ChatGroq } from "@langchain/groq";
import { START, END, StateGraph, MessagesAnnotation } from "@langchain/langgraph" ;
import { HumanMessage, BaseMessage, ToolMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { Injectable } from '@nestjs/common';
import { config } from 'dotenv';
config() ;


@Injectable()
export class AppService {
  agent: any ;
  onModuleInit() {
    // Model definition
    const llm = new ChatGroq({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      maxTokens: undefined,
      maxRetries: 2,
    }) ;
    //#########################################################################
    
    // Tools definition
    const isMagic = tool(
      async ({a}: {a: number}) => {
        return (a % 17 === 0) ? "The given number is magic" : "The given number is not magic" ;
      },
      {
        name: "isMagic",
        description: "Tells if a number is magic or not, use it EVERYTIME asked if a number is magic",
        schema: z.object({
          a: z.number().describe("The candidate number to be magic or not")
        }),
      }
    ) ;

    const toolsByName = { [isMagic.name]: isMagic } ;
    //#########################################################################
    
    // Model needs to aknowledge the tools
    const model = llm.bindTools([isMagic]) ;

    // Nodes definitions
    const modelNode = async ({ messages }: { messages: BaseMessage[] }) => {
      const response = await model.invoke(
        [
          new SystemMessage(
            "You are a magic tool, you can use your tools to respond to questions about magic stuff."
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
        const obs = await tool.invoke(toolCall) ;
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
