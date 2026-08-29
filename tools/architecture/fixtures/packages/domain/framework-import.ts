// Violates no-framework-in-packages. NestJS is not installed on purpose: the
// rule has to catch the import before the dependency exists.
import { Injectable } from '@nestjs/common';

export const decorate = Injectable;
