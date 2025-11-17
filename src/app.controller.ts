import { Controller, Get, Body } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  async getHello(@Body('msg') msg: string) {
    return await this.appService.getHello(msg);
  }
}
