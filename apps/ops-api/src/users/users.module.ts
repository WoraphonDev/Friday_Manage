import { Module } from '@nestjs/common';

/** ผู้ใช้ทั้งระบบ (O02) · O01 เตรียม module ว่างไว้ให้งานนั้นเพิ่ม controller / provider ใน lane ของตัวเอง โดยไม่ต้องแก้ app.module */
@Module({})
export class UsersModule {}
