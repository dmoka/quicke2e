<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { CUSTOMERS, PLANS, CREDS, successText } from "../shared/data.js";
import { here, nav, onNav, link } from "../shared/router.js";

const route = ref(here());
let off; onMounted(() => (off = onNav(() => (route.value = here())))); onUnmounted(() => off && off());
const u = computed(() => new URL(route.value, location.origin));
const path = computed(() => u.value.pathname);
const q = computed(() => u.value.searchParams);
const customer = computed(() => CUSTOMERS.find((c) => `/customers/${c.id}` === path.value));

const login = reactive({ email: "", password: "" }), loginErr = ref("");
function doLogin() {
  if (login.email === CREDS.email && login.password === CREDS.password) nav("/home?u=" + encodeURIComponent(login.email));
  else loginErr.value = "Invalid email or password";
}
const form = reactive({ name: "", plan: "", terms: false }), formErr = ref("");
function doCreate() {
  if (!form.name) return (formErr.value = "Project name is required");
  if (!form.plan) return (formErr.value = "Please choose a plan");
  if (!form.terms) return (formErr.value = "Please accept the terms");
  nav(`/success?name=${encodeURIComponent(form.name)}&plan=${encodeURIComponent(form.plan)}&terms=yes`);
}
</script>

<template>
  <el-menu mode="horizontal" :ellipsis="false">
    <el-menu-item index="1"><a href="/home" @click="link('/home')($event)">Home</a></el-menu-item>
    <el-menu-item index="2"><a href="/customers" @click="link('/customers')($event)">Customers</a></el-menu-item>
    <el-menu-item index="3"><a href="/form" @click="link('/form')($event)">New project</a></el-menu-item>
  </el-menu>
  <main style="padding: 20px">
    <el-form v-if="path === '/login' || path === '/'" label-position="top" style="max-width: 360px" @submit.prevent="doLogin">
      <h1>Sign in</h1>
      <el-form-item label="Email" for="email"><el-input id="email" v-model="login.email" /></el-form-item>
      <el-form-item label="Password" for="password"><el-input id="password" v-model="login.password" type="password" /></el-form-item>
      <el-button type="primary" native-type="submit">Sign in</el-button>
      <el-alert v-if="loginErr" type="error" :title="loginErr" :closable="false" />
    </el-form>
    <h1 v-else-if="path === '/home'">{{ q.get("u") ? `Welcome, ${q.get("u")}` : "Home" }}</h1>
    <el-form v-else-if="path === '/form'" label-position="top" style="max-width: 360px" @submit.prevent="doCreate">
      <h1>New project</h1>
      <el-form-item label="Project name" for="name"><el-input id="name" v-model="form.name" /></el-form-item>
      <el-form-item label="Plan" for="plan">
        <el-select id="plan" v-model="form.plan" placeholder="Choose a plan">
          <el-option v-for="p in PLANS" :key="p" :label="p" :value="p" />
        </el-select>
      </el-form-item>
      <el-form-item><el-checkbox v-model="form.terms">I accept the terms</el-checkbox></el-form-item>
      <el-button type="primary" native-type="submit">Create project</el-button>
      <el-alert v-if="formErr" type="error" :title="formErr" :closable="false" />
    </el-form>
    <h1 v-else-if="path === '/success'">{{ successText(q.get("name"), q.get("plan")) }}</h1>
    <template v-else-if="path === '/customers'">
      <h1>Customers</h1>
      <el-table :data="CUSTOMERS" size="small">
        <el-table-column label="Name"><template #default="{ row }">
          <a :href="`/customers/${row.id}`" @click="link(`/customers/${row.id}`)($event)">{{ row.name }}</a>
        </template></el-table-column>
        <el-table-column prop="email" label="Email" /><el-table-column prop="city" label="City" />
      </el-table>
    </template>
    <h1 v-else-if="customer">Customer detail: {{ customer.name }}</h1>
    <p v-else>Not found</p>
  </main>
</template>
